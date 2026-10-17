#!/usr/bin/env node
// Test double for the Antigravity CLI headless stream contract (docs:
// --input-format stream-json + --output-format stream-json). The prompt
// arrives as a {"event":"user","message":{"content":...}} line on stdin; the
// terminal {"event":"result"} line carries the envelope. Behavior is selected
// with AGY_DOUBLE_BEHAVIOR: success | auth | garbage | slow | empty. When
// AGY_DOUBLE_LEN_FILE is set, the double records the received prompt length
// and its own argv length there, so tests can prove the prompt travelled over
// stdin rather than the command line.
const behavior = process.env.AGY_DOUBLE_BEHAVIOR || 'success';

if (behavior === 'slow') {
  setTimeout(() => {}, 30000);
} else if (behavior === 'auth') {
  process.stderr.write('authentication required: run `agy` interactively first\n');
  process.exit(1);
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', async () => {
    let promptLen = 0;
    for (const line of input.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.event === 'user') promptLen += String(event.message?.content ?? '').length;
      } catch {
        // malformed input lines are ignored by the double
      }
    }
    if (process.env.AGY_DOUBLE_LEN_FILE) {
      const fs = await import('node:fs');
      fs.writeFileSync(
        process.env.AGY_DOUBLE_LEN_FILE,
        JSON.stringify({ argvLen: process.argv.join(' ').length, promptLen })
      );
    }
    if (behavior === 'garbage') {
      process.stdout.write('this is not json\n');
      return;
    }
    if (behavior === 'empty') {
      process.stdout.write(
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', response: '', duration_seconds: 0.1, num_turns: 1 }
        }) + '\n'
      );
      return;
    }
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
      JSON.stringify({ event: 'init', conversation_id: 'test-conversation', init: {} }) + '\n'
    );
    process.stdout.write(
      JSON.stringify({
        event: 'step_update',
        step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' }
      }) + '\n'
    );
    process.stdout.write(
      JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'test-conversation',
          status: 'SUCCESS',
          response: JSON.stringify(answer),
          structured_output: answer,
          duration_seconds: 1.2,
          num_turns: 1,
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 }
        }
      }) + '\n'
    );
  });
  process.stdin.resume();
}
