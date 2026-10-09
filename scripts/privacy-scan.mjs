import {execFileSync} from 'node:child_process';
import {readFileSync,existsSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';
const tracked=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const untracked=execFileSync('git',['ls-files','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const files=new Set([...tracked,...untracked].filter(f=>existsSync(f)&&statSync(f).isFile()));
function walk(dir){if(!existsSync(dir))return;for(const name of readdirSync(dir)){const file=path.join(dir,name);if(statSync(file).isDirectory())walk(file);else files.add(file);}}
walk('frontend/dist');walk('server/dist');
const failures=[];
const patterns=[
 ['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['GitHub token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
 ['AWS access key',/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
 ['bot credential',/\b\d{8,}:[A-Za-z0-9_-]{30,}\b/],
 ['credential assignment',/(?:JWT_SECRET|CHANNEL_KEY|SMTP_PASSWORD|TELEGRAM_TOKEN)\s*=\s*[a-zA-Z0-9_\-/+]{16,}/]
];
for(const file of files){
 if(/(^|\/)(?:\.env(?:\..*)?|backups?|data|screenshots)(?:\/|$)/.test(file)&&!file.endsWith('.env.example')){failures.push([file,'private runtime file']);continue;}
 const buffer=readFileSync(file);if(buffer.includes(0))continue;const text=buffer.toString();
 for(const [label,re] of patterns)if(re.test(text))failures.push([file,label]);
 for(const match of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)){
  const email=match[0];if(!email.endsWith('@example.com')&&!email.endsWith('@example.invalid')&&email!=='codex@openai.com'&&!file.includes('package-lock.json'))failures.push([file,'non-fixture email']);
 }
 // Optional private identifiers are supplied locally, never printed or stored.
 for(const value of (process.env.PRIVACY_FORBIDDEN_SUBSTRINGS??'').split(',').filter(Boolean))if(text.toLowerCase().includes(value.toLowerCase()))failures.push([file,'forbidden private identifier']);
}
if(failures.length){for(const [file,label] of failures)console.error(`${file}: ${label}`);process.exitCode=1;}else console.log(`Privacy scan passed: ${files.size} source/build files. Manual domain/infrastructure review is still required.`);
