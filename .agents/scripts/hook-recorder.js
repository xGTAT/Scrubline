const fs = require('fs');
const path = require('path');

const eventType = process.argv[2] || 'unknown';
const logFile = path.join(__dirname, '..', 'hook-events.jsonl');

let rawData = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', chunk => {
  rawData += chunk;
});

process.stdin.on('end', () => {
  let parsedPayload = null;
  try {
    if (rawData.trim()) {
      parsedPayload = JSON.parse(rawData);
    }
  } catch (err) {
    parsedPayload = { parseError: err.message, raw: rawData };
  }

  const record = {
    timestamp: new Date().toISOString(),
    event: eventType,
    payload: parsedPayload
  };

  try {
    fs.appendFileSync(logFile, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    console.error('Failed to write log:', err);
  }

  // Contract: PostToolUse expects empty object {}, Stop expects empty object or { decision: ... }
  if (eventType === 'stop') {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
  } else {
    process.stdout.write(JSON.stringify({}));
  }
});
