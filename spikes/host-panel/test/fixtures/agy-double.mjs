#!/usr/bin/env node
// Test double for the Antigravity CLI headless contract (docs: agy -p, --output-format json,
// --json-schema). Behavior is selected with AGY_DOUBLE_BEHAVIOR: success | auth | garbage |
// slow | empty. Verifies the extension speaks to the documented envelope, not to a library.
const behavior = process.env.AGY_DOUBLE_BEHAVIOR || 'success';

if (behavior === 'slow') {
  setTimeout(() => {}, 30000);
} else if (behavior === 'auth') {
  process.stderr.write('authentication required: run `agy` interactively first\n');
  process.exit(1);
} else if (behavior === 'garbage') {
  process.stdout.write('this is not json\n');
} else if (behavior === 'empty') {
  process.stdout.write(
    JSON.stringify({ status: 'SUCCESS', response: '', duration_seconds: 0.1, num_turns: 1 }) + '\n'
  );
} else {
  const answer = {
    summary: 'The nav spacing is inconsistent with the hero.',
    directAnswer: 'Tighten the nav gap to 8px and match the hero padding.',
    findings: [
      {
        type: 'issue',
        category: 'spacing',
        title: 'Nav gap drift',
        details: 'The nav uses 24px while the hero uses 16px.'
      }
    ],
    recommendations: [
      {
        category: 'spacing',
        priority: 'medium',
        title: 'Unify spacing tokens',
        description: 'Use one 8px-based scale.',
        rationale: 'Mixed scales read as accidental.',
        tradeOffs: 'Slightly denser nav.'
      }
    ],
    disclaimers: ['Only index.html was inspected.']
  };
  process.stdout.write(
    JSON.stringify({
      conversation_id: 'test-conversation',
      status: 'SUCCESS',
      response: JSON.stringify(answer),
      structured_output: answer,
      duration_seconds: 1.2,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 }
    }) + '\n'
  );
}
