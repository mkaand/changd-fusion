"""Private, host-key-pinned production SSH access and READ-ONLY inventory.

No endpoint, credential, real domain or infrastructure ID belongs in this file.
Remote output stays in a private Cloud directory, never CI stdout/artifacts.
"""
import argparse
import base64
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile

ENV_NAMES = ('PRODUCTION_SSH_HOST', 'PRODUCTION_SSH_USER', 'PRODUCTION_SSH_HOST_KEY')
DEFAULT_STATE = Path('/workspace/.private/changd-fusion-access')


def settings(env):
    missing = [name for name in ENV_NAMES if not env.get(name)]
    if missing:
        raise ValueError('Missing secure environment fields: ' + ', '.join(missing))
    host, user, key = [env[name].strip() for name in ENV_NAMES]
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?', host):
            raise ValueError('Invalid SSH endpoint')
    if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', user):
        raise ValueError('Invalid SSH account')
    try:
        port = int(env.get('PRODUCTION_SSH_PORT', '22'))
    except (ValueError, TypeError):
        raise ValueError('Invalid SSH port') from None
    if not 1 <= port <= 65535:
        raise ValueError('Invalid SSH port')
    parts = key.split()
    if len(parts) not in (2, 3) or parts[0] != 'ssh-ed25519':
        raise ValueError('A verified Ed25519 server host public key is required')
    try:
        raw = base64.b64decode(parts[1], validate=True)
        if len(raw) != 51 or raw[:19] != b'\0\0\0\x0bssh-ed25519\0\0\0\x20':
            raise ValueError()
    except ValueError:
        raise ValueError('Invalid server host public key') from None
    return host, user, port, ' '.join(parts[:2])


def private_dir(directory):
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Unsafe private access directory')


def private_file(file, value):
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Unsafe private access file')
        os.ftruncate(fd, 0)
        data = memoryview(value.encode())
        while data:
            written = os.write(fd, data)
            if not written:
                raise OSError('Private file write failed')
            data = data[written:]
        os.fsync(fd)
    finally:
        os.close(fd)


def ssh_command(config, directory, remote_command):
    host, user, port, host_key = config
    key = directory / 'bootstrap-ed25519'
    info = key.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        raise ValueError('Unsafe SSH private key file')
    hosts = directory / 'known_hosts'
    private_file(hosts, f'[{host}]:{port} {host_key}\n' if port != 22 else f'{host} {host_key}\n')
    return ['ssh', '-F', '/dev/null', '-T', '-i', str(key), '-l', user, '-p', str(port),
            '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(hosts),
            '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
            '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1',
            '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', '-o', 'LogLevel=ERROR',
            '--', host, remote_command]


# Only inventory commands. Never docker inspect Env, nginx -T, log dumps or credentials.
REMOTE_INVENTORY = r'''
import json, subprocess, pathlib, os, shutil
checks = {
 'os': ['cat','/etc/os-release'],
 'kernel': ['uname','-sr'],
 'cpu': ['getconf','_NPROCESSORS_ONLN'],
 'memory_swap': ['free','-b'],
 'disk': ['df','-B1','/','/opt'],
 'docker': ['docker','version','--format','{{json .Server}}'],
 'compose': ['docker','compose','version','--short'],
 'containers': ['docker','ps','--format','{{json .}}'],
 'container_usage': ['docker','stats','--no-stream','--format','{{json .}}'],
 'localhost_listeners': ['ss','-lntp'],
 'firewall': ['ufw','status','verbose'],
 'nft_rules': ['nft','list','ruleset'],
 'apparmor': ['aa-status','--json'],
 'namespace_policy': ['sysctl','kernel.unprivileged_userns_clone','user.max_user_namespaces','kernel.apparmor_restrict_unprivileged_userns'],
 'nginx_syntax': ['nginx','-t'],
 'hestia_package': ['dpkg-query','-W','-f=${Version}','hestia'],
 'service_health': ['systemctl','--failed','--no-legend'],
 'backup_timer_metadata': ['systemctl','list-timers','--all','--no-pager','--no-legend'],
 'filesystem_mount_options': ['findmnt','-no','TARGET,FSTYPE,OPTIONS','/opt'],
}
out={'read_only':True,'effective_uid':os.geteuid(),'checks':{},'hestia_installed':pathlib.Path('/usr/local/hestia').is_dir()}
for name,args in checks.items():
 try:
  r=subprocess.run(args,capture_output=True,text=True,timeout=8)
  out['checks'][name]={'exit_code':r.returncode,'stdout':r.stdout[:150000],'stderr':r.stderr[:10000]}
 except (OSError,subprocess.TimeoutExpired):
  out['checks'][name]={'unavailable':True}
print(json.dumps(out))
'''


def run(operation, env, directory=DEFAULT_STATE, runner=subprocess.run):
    config = settings(env)
    private_dir(directory)
    remote = 'true' if operation == 'check' else ('python3 -' if config[1] == 'root' else 'sudo -n python3 -')
    command = ssh_command(config, directory, remote)
    try:
        result = runner(command, input='' if operation == 'check' else REMOTE_INVENTORY,
                        capture_output=True, text=True, timeout=240 if operation == 'preflight' else 20)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError('SSH transport unavailable or timed out; no production change made') from None
    private_file(directory / 'ssh-diagnostics.txt', result.stderr)
    if result.returncode:
        raise RuntimeError('SSH authorization, host verification or read-only inventory failed; private diagnostics retained')
    if operation == 'preflight':
        try:
            data = json.loads(result.stdout)
            if data.get('read_only') is not True or data.get('effective_uid') != 0:
                raise ValueError()
        except (ValueError, AttributeError):
            raise RuntimeError('Read-only inventory result was incomplete') from None
        private_file(directory / 'preflight.json', json.dumps(data, indent=2))
    return {'operation':operation,'connected':True,'production_modified':False}


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation',choices=['check','preflight'])
    args=parser.parse_args()
    try:
        print(json.dumps(run(args.operation,os.environ)))
    except (ValueError,RuntimeError,OSError) as error:
        # OS/SSH errors may contain private endpoints. Do not print them.
        print(str(error) if isinstance(error,(ValueError,RuntimeError)) else 'Private SSH access file unavailable')
        raise SystemExit(1)
