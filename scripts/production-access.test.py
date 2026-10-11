import importlib.util
import unittest
from pathlib import Path
import tempfile
import base64
import os
import types
import subprocess

spec=importlib.util.spec_from_file_location('access',Path(__file__).with_name('production-access.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
KEY='ssh-ed25519 '+base64.b64encode(b'\0\0\0\x0bssh-ed25519\0\0\0\x20'+b'x'*32).decode()
ENV={'PRODUCTION_SSH_HOST':'example.com','PRODUCTION_SSH_USER':'fixture','PRODUCTION_SSH_HOST_KEY':KEY}

class AccessTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.root.chmod(0o700)
  (self.root/'bootstrap-ed25519').write_text('synthetic fixture');(self.root/'bootstrap-ed25519').chmod(0o600)
 def tearDown(self):self.temp.cleanup()
 def test_missing_fields_do_not_attempt_network(self):
  with self.assertRaisesRegex(ValueError,'Missing secure environment'):
   m.run('check',{},self.root,lambda *a,**kw:self.fail('Unexpected network'))
 def test_endpoint_account_port_and_host_key_are_validated(self):
  for replacement in [{'PRODUCTION_SSH_HOST':'-oProxyCommand=invalid'}, {'PRODUCTION_SSH_HOST':'example.com\ninvalid'}, {'PRODUCTION_SSH_USER':'root;invalid'}, {'PRODUCTION_SSH_PORT':'0'}, {'PRODUCTION_SSH_PORT':'synthetic-private-value'}, {'PRODUCTION_SSH_HOST_KEY':'ssh-rsa fixture'}, {'PRODUCTION_SSH_HOST_KEY':'ssh-ed25519 bad'}]:
   with self.subTest(replacement=replacement),self.assertRaises(ValueError):m.settings({**ENV,**replacement})
 def test_identity_and_host_pin_are_enforced_without_agent_or_tofu(self):
  calls=[]
  def runner(args,**kw):calls.append((args,kw));return types.SimpleNamespace(returncode=0,stdout='',stderr='')
  self.assertEqual(m.run('check',ENV,self.root,runner)['production_modified'],False)
  args,kw=calls[0]
  for flag in ['StrictHostKeyChecking=yes','BatchMode=yes','IdentitiesOnly=yes','IdentityAgent=none','ForwardAgent=no','ClearAllForwardings=yes']:self.assertIn(flag,args)
  self.assertEqual(args[-1],'true');self.assertEqual(kw['timeout'],20)
  self.assertEqual((self.root/'known_hosts').read_text(),'example.com '+KEY+'\n')
 def test_nonstandard_port_and_ipv6_have_exact_known_host_entries(self):
  config=m.settings({**ENV,'PRODUCTION_SSH_HOST':'2001:db8::1','PRODUCTION_SSH_PORT':'2222'})
  m.ssh_command(config,self.root,'true')
  self.assertEqual((self.root/'known_hosts').read_text(),'[2001:db8::1]:2222 '+KEY+'\n')
 def test_world_readable_private_key_and_symlinks_are_refused(self):
  key=self.root/'bootstrap-ed25519';key.chmod(0o644)
  with self.assertRaises(ValueError):m.ssh_command(m.settings(ENV),self.root,'true')
  key.unlink();key.symlink_to(self.root/'missing')
  with self.assertRaises(ValueError):m.ssh_command(m.settings(ENV),self.root,'true')
 def test_failure_keeps_private_details_out_of_exception(self):
  secret='synthetic-private-infrastructure'
  def runner(*a,**kw):return types.SimpleNamespace(returncode=255,stdout='',stderr=secret)
  with self.assertRaises(RuntimeError) as ctx:m.run('check',ENV,self.root,runner)
  self.assertNotIn(secret,str(ctx.exception));self.assertEqual((self.root/'ssh-diagnostics.txt').read_text(),secret)
  self.assertEqual((self.root/'ssh-diagnostics.txt').stat().st_mode&0o777,0o600)
 def test_inventory_is_read_only_and_kept_in_private_file(self):
  def runner(args,**kw):
   self.assertEqual(args[-1],'sudo -n python3 -');self.assertNotIn('nginx -T',kw['input']);self.assertNotIn('docker inspect',kw['input'])
   return types.SimpleNamespace(returncode=0,stdout='{"read_only":true,"effective_uid":0,"checks":{}}',stderr='')
  self.assertTrue(m.run('preflight',ENV,self.root,runner)['connected'])
  self.assertEqual((self.root/'preflight.json').stat().st_mode&0o777,0o600)
 def test_timeouts_are_finite_and_sanitized(self):
  def runner(*a,**kw):raise subprocess.TimeoutExpired('synthetic-private-host',kw['timeout'])
  with self.assertRaisesRegex(RuntimeError,'timed out'):m.run('preflight',ENV,self.root,runner)

if __name__=='__main__':unittest.main()
