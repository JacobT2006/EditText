const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const channel = process.env.CHANNEL;
if (!['stable', 'alpha', 'beta'].includes(channel)) {
  throw new Error(`Unsupported release channel: ${channel}`);
}

function runGit(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function parseStableTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

function getCommitBump(message) {
  const [subject, ...body] = message.split(/\r?\n/);
  const conventional = /^([a-z][a-z0-9-]*)(?:\([^()\r\n]+\))?(!)?:\s+.+$/i.exec(subject);
  const breaking = Boolean(conventional?.[2]) || body.some((line) => /^BREAKING CHANGE:\s*\S/i.test(line));
  if (breaking) return 3;
  if (conventional?.[1].toLowerCase() === 'feat' || /^(add|create|implement|introduce)\b/i.test(subject)) return 2;
  if (conventional && ['fix', 'perf'].includes(conventional[1].toLowerCase())) return 1;
  if (/^(fix|improve|optimi[sz]e|repair|resolve|update)\b/i.test(subject)) return 1;
  return 0;
}

const tags = runGit(['tag', '--merged', 'HEAD', '--list'])
  .split(/\r?\n/)
  .map((tag) => ({ tag, version: parseStableTag(tag) }))
  .filter((entry) => entry.version)
  .sort((left, right) => compareVersions(right.version, left.version));
const latestStable = tags[0];
const baseVersion = latestStable?.version ?? [0, 0, 0];
const range = latestStable ? `${latestStable.tag}..HEAD` : 'HEAD';
const messages = runGit(['log', '--no-merges', '--format=%B%x00', range])
  .split('\0')
  .map((message) => message.trim())
  .filter(Boolean);

if (messages.length === 0) {
  throw new Error('No commits found since the latest stable release.');
}

const bump = Math.max(1, ...messages.map(getCommitBump));
const nextVersion = [...baseVersion];
if (bump === 3) {
  nextVersion[0] += 1;
  nextVersion[1] = 0;
  nextVersion[2] = 0;
} else if (bump === 2) {
  nextVersion[1] += 1;
  nextVersion[2] = 0;
} else {
  nextVersion[2] += 1;
}

const version = nextVersion.join('.');
let result = version;
if (channel !== 'stable') {
  const prefix = `v${version}-${channel}.`;
  const priorNumbers = runGit(['tag', '--merged', 'HEAD', '--list', `${prefix}*`])
    .split(/\r?\n/)
    .map((tag) => new RegExp(`^${prefix}(\\d+)$`).exec(tag))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  result = `${version}-${channel}.${priorNumbers.length ? Math.max(...priorNumbers) + 1 : 0}`;
}

console.log(`Latest stable: ${latestStable?.tag ?? 'none'}`);
console.log(`Release channel: ${channel}`);
console.log(`Inferred bump: ${['', 'patch', 'minor', 'major'][bump]}`);
console.log(`Next version: ${result}`);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${result}\n`);
}
