#!/usr/bin/env node
/**
 * Fails (exit 1) if any commit in history carries the Codebuff attribution footer.
 * The repository must never contain "Generated with Codebuff" / "Co-Authored-By: Codebuff".
 * Run via `npm run check:commits` and as a CI gate.
 */
import { execFileSync } from 'node:child_process';

const log = execFileSync('git', ['log', '--all', '--format=%B'], { encoding: 'utf8' });
const forbidden = ['Generated with Codebuff', 'Co-Authored-By: Codebuff'];
const hits = log.split('\n').filter((line) => forbidden.some((f) => line.toLowerCase().includes(f.toLowerCase())));

if (hits.length > 0) {
  console.error('Forbidden Codebuff attribution footer found in commit history:');
  for (const hit of hits) console.error(`  ${hit}`);
  console.error('This footer must never be added to the repository.');
  console.error('Strip it from the commit messages and force-push the corrected history.');
  process.exit(1);
}

console.log('commit history clean: no Codebuff attribution footer');
