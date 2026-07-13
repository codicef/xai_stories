// ============================================================
// CONFIGURATION — edit this file to set up your study
// ============================================================

const CONFIG = {
  // List of predefined evaluator usernames.
  // Add/remove names here before deploying.
  // Ordering matters: index is used as part of the assignment seed.
  users: [
    'Caroline Bret',
    'Elvira Garcia de Paco',
    'Morgane Thomas',
    'Jérôme Moreaux',
    'Francesco Codicè',
    'Ziyun Pan',
    'André Mas',
  ],

  // Number of patient cases per session (each case has 4 texts to rate)
  casesPerSession: 10,

  // Total cases per user (25 cases × 4 texts = 100 individual text ratings)
  totalCasesPerUser: 25,

  // Likert criteria shown for each narrative
  criteria: [
    {
      id: 'faithfulness',
      name: 'Faithfulness to the Evidence',
      short: 'Faithfulness',
      description:
        'To what extent does the narrative accurately reflect the evidence provided by the model explanation (SHAP values)?',
      anchors: {
        1: 'Largely inconsistent with evidence; major factors missing or contradicted.',
        3: 'Moderately faithful; captures some key factors but omits or misrepresents others.',
        5: 'Highly faithful; accurately represents all key factors and their direction without unsupported claims.',
      },
    },
    {
      id: 'plausibility',
      name: 'Clinical Plausibility',
      short: 'Plausibility',
      description:
        'To what extent is the explanation medically reasonable and consistent with current clinical understanding?',
      anchors: {
        1: 'Clinically implausible or misleading; contains major medical inconsistencies.',
        3: 'Generally plausible but contains some weak or uncertain reasoning.',
        5: 'Highly plausible; reasoning is consistent with established clinical knowledge and the patient profile.',
      },
    },
    {
      id: 'clarity',
      name: 'Clarity and Communication Quality',
      short: 'Clarity',
      description:
        'How effectively does the narrative communicate the explanation to a clinician? (Organisation, readability, conciseness.)',
      anchors: {
        1: 'Difficult to understand; disorganised, confusing, or contradictory.',
        3: 'Understandable but uneven in clarity, structure, or level of detail.',
        5: 'Exceptionally clear, concise, and logically structured; easy to understand at a glance.',
      },
    },
    {
      id: 'usefulness',
      name: 'Practical Clinical Usefulness',
      short: 'Usefulness',
      description:
        'How useful would this explanation be for helping a clinician understand the model\'s prediction, with respect to the numerical explanation?',
      anchors: {
        1: 'Not useful; provides little or no insight into the prediction.',
        3: 'Moderately useful; provides some helpful information.',
        5: 'Highly useful; provides clear, informative, and actionable understanding of the prediction.',
      },
    },
  ],
};
