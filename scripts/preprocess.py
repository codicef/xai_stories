#!/usr/bin/env python3
"""
Preprocess CSV data into stories.json for the XAI evaluation platform.
Run from the project root: python3 scripts/preprocess.py
"""

import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / 'data'

LLMS = [
    '01-ai_Yi-1.5-34B-Chat',
    'deepseek-ai_DeepSeek-R1-Distill-Llama-70B',
    'google_gemma-3-27b-it',
    'openai_gpt-oss-120b',
]

DATASET_LABELS = {
    'metabric': 'METABRIC Breast Cancer Cohort',
    'mm': 'Multiple Myeloma Cohort',
}


def parse_evidence(prompt: str) -> dict:
    result = {}

    # Predicted survival
    m = re.search(r'predicted a median survival time of ([\d.]+) (months|days)', prompt)
    result['predicted_survival'] = f"{m.group(1)} {m.group(2)}" if m else None

    # Actual outcome
    m = re.search(r'outcome is the following:\s*(.+?)(?:\n\s*\n|\n\s*The model)', prompt, re.DOTALL)
    result['actual_outcome'] = m.group(1).strip() if m else None

    # SHAP table
    m = re.search(r'in this table:\s*\n(.*?)(?:\n[ \t]*\n)', prompt, re.DOTALL)
    features = []
    if m:
        for line in m.group(1).strip().split('\n'):
            line = line.strip()
            if not line:
                continue
            fm = re.match(r'\d+\.\s+(.+?):\s*([^\(]+?)\s*\(SHAP\s*([+\-][\d.eE+\-]+)\)', line)
            if fm:
                raw_val = fm.group(2).strip()
                display_val = 'N/A' if raw_val in ('-999999.0', '-999999') else raw_val
                features.append({
                    'name': fm.group(1).strip(),
                    'value': display_val,
                    'shap': float(fm.group(3)),
                })
    result['shap_features'] = features

    # Feature descriptions
    m = re.search(r'clarification of the features:\s*\n(.*?)(?:\n[ \t]*\n[ \t]*$|\Z)', prompt, re.DOTALL)
    descriptions = {}
    if m:
        current_name = None
        current_parts = []
        for line in m.group(1).strip().split('\n'):
            line = line.strip()
            if not line:
                continue
            fm = re.match(r'\d+\.\s+(.+?):\s*(.+)', line)
            if fm:
                if current_name:
                    descriptions[current_name] = ' '.join(current_parts)
                current_name = fm.group(1).strip()
                desc = fm.group(2).strip()
                # Remove duplicate "Name: " prefix
                if desc.startswith(current_name + ':'):
                    desc = desc[len(current_name) + 1:].strip()
                current_parts = [desc]
            elif current_name:
                current_parts.append(line)
        if current_name:
            descriptions[current_name] = ' '.join(current_parts)
    result['feature_descriptions'] = descriptions

    return result


def main():
    cases = {}

    for dataset in ['metabric', 'mm']:
        for llm in LLMS:
            filename = f'100sample_{dataset}_{llm}.csv'
            filepath = DATA_DIR / filename
            if not filepath.exists():
                print(f'WARNING: {filepath} not found, skipping', file=sys.stderr)
                continue

            with open(filepath, newline='', encoding='utf-8') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    idx = row['sample_idx']
                    case_id = f"{dataset}_{idx}"

                    if case_id not in cases:
                        evidence = parse_evidence(row['prompt'])
                        cases[case_id] = {
                            'id': case_id,
                            'dataset': dataset,
                            'dataset_label': DATASET_LABELS[dataset],
                            'sample_idx': idx,
                            'evidence': evidence,
                            'narratives': {},
                        }

                    cases[case_id]['narratives'][llm] = row['response_text'].strip()

    # Separate by dataset and sort for reproducibility
    metabric_cases = sorted(
        [c for c in cases.values() if c['dataset'] == 'metabric'],
        key=lambda c: float(c['sample_idx'])
    )
    mm_cases = sorted(
        [c for c in cases.values() if c['dataset'] == 'mm'],
        key=lambda c: float(c['sample_idx'])
    )

    all_cases = metabric_cases + mm_cases

    # Verify all 4 narratives present
    missing = 0
    for c in all_cases:
        for llm in LLMS:
            if llm not in c['narratives']:
                print(f'WARNING: Missing narrative for {c["id"]} / {llm}', file=sys.stderr)
                missing += 1
    if missing == 0:
        print(f'All narratives present for {len(all_cases)} cases.')

    output = {
        'llms': LLMS,
        'cases': all_cases,
    }

    out_path = DATA_DIR / 'stories.json'
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, separators=(',', ':'))

    size_mb = out_path.stat().st_size / 1_000_000
    print(f'Saved {len(all_cases)} cases → {out_path} ({size_mb:.1f} MB)')

    # ── METABRIC-only assignment (Francesco & Ziyun) ─────────────
    # 2 users × 25 cases = 50 assignments over 100 METABRIC cases.
    # Non-overlapping, interleaved (even/odd indices) so both users
    # sample the same spread of the distribution rather than one
    # taking early cases and the other late cases.
    METABRIC_EVALUATORS = [
        'Francesco Codicè',
        'Ziyun Pan',
    ]

    metabric_assignment = {
        'Francesco Codicè': [c['id'] for c in metabric_cases[0::2][:25]],
        'Ziyun Pan':        [c['id'] for c in metabric_cases[1::2][:25]],
    }

    cov_m = Counter(cid for ids in metabric_assignment.values() for cid in ids)
    print(f'\nMETABRIC-only assignment (2 evaluators, 25 cases each):')
    print(f'  Covered 1×: {sum(1 for v in cov_m.values() if v==1)} cases  |  Uncovered: {len(metabric_cases) - len(cov_m)}')

    # ── MM-only uniform assignment ────────────────────────────────
    # These evaluators review ONLY MM cases, distributed as uniformly as possible.
    # 5 users × 25 cases = 125 assignments over 100 MM cases:
    #   → 75 cases seen by exactly 1 user, 25 cases seen by exactly 2 users.
    # Strategy: each user gets a non-overlapping primary block of 20 cases +
    # a secondary block of 5 cases taken from 2 positions ahead (circular),
    # so the "double-covered" cases are evenly spread across the 100-case range.
    MM_EVALUATORS = [
        'Caroline Bret',
        'Elvira Garcia de Paco',
        'Morgane Thomas',
        'Jérôme Moreaux',
        'André Mas',
    ]

    n_mm = len(mm_cases)          # 100
    n_eval = len(MM_EVALUATORS)   # 5
    block = n_mm // n_eval        # 20 primary cases per user
    secondary = 25 - block        # 5 extra cases per user

    mm_assignment = {}
    for i, user in enumerate(MM_EVALUATORS):
        primary_ids   = [c['id'] for c in mm_cases[i * block : (i + 1) * block]]
        sec_start     = ((i + 2) * block) % n_mm
        secondary_ids = [c['id'] for c in mm_cases[sec_start : sec_start + secondary]]
        mm_assignment[user] = primary_ids + secondary_ids

    # Print coverage report
    cov = Counter(cid for ids in mm_assignment.values() for cid in ids)
    once  = sum(1 for v in cov.values() if v == 1)
    twice = sum(1 for v in cov.values() if v == 2)
    print(f'\nMM-only assignment ({n_eval} evaluators, {25} cases each):')
    print(f'  Covered 1×: {once} cases  |  Covered 2×: {twice} cases  |  Uncovered: {n_mm - len(cov)}')

    all_assignments = {**metabric_assignment, **mm_assignment}
    assign_path = DATA_DIR / 'assignments.json'
    with open(assign_path, 'w', encoding='utf-8') as f:
        json.dump(all_assignments, f, ensure_ascii=False, indent=2)
    print(f'  Saved → {assign_path}')
    print(f'  METABRIC: {len(metabric_cases)} cases')
    print(f'  MM:       {len(mm_cases)} cases')


if __name__ == '__main__':
    main()
