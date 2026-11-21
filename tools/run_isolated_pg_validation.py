import json, os, select, socketserver, subprocess, sys, threading
import paramiko, base64

class Forward(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        channel = transport.open_channel('direct-tcpip', ('127.0.0.1', 47432), self.request.getpeername())
        try:
            while True:
                ready, _, _ = select.select([self.request, channel], [], [])
                if self.request in ready:
                    data = self.request.recv(65536)
                    if not data: break
                    channel.sendall(data)
                if channel in ready:
                    data = channel.recv(65536)
                    if not data: break
                    self.request.sendall(data)
        finally:
            channel.close()

credential = json.load(sys.stdin)
client = paramiko.SSHClient()
client.get_host_keys().add(credential['host'], 'ssh-ed25519', paramiko.Ed25519Key(data=base64.b64decode('AAAAC3NzaC1lZDI1NTE5AAAAIAJKJcvlLJ6wL2jxUpeBVNsL7fzf13w7YFhaR2ZeSs68')))
client.set_missing_host_key_policy(paramiko.RejectPolicy())
client.connect(credential['host'], port=int(credential['port']), username=credential['username'], password=credential['password'], timeout=8, allow_agent=False, look_for_keys=False)
transport = client.get_transport()
try:
    with Forward(('127.0.0.1', 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        env = dict(os.environ)
        database = sys.argv[1] if len(sys.argv) > 1 else 'voipgw_test_run1'
        if database not in ('voipgw_test_run1', 'voipgw_test_run2', 'voipgw_test_run3', 'voipgw_test_run4', 'voipgw_quarantine_test', 'voipgw_quarantine_test_run2', 'voipgw_quarantine_test_run3', 'voipgw_quarantine_session_test'):
            raise ValueError('Unsupported isolated test database')
        url = 'postgresql://carzygod@127.0.0.1:%d/%s' % (server.server_address[1], database)
        if database == 'voipgw_quarantine_session_test':
            env['VOIPGW_QUARANTINE_SESSION_TEST_DATABASE_URL'] = url
            env['VOIPGW_QUARANTINE_SESSION_TEST_ENABLE'] = 'yes'
            test = 'test/sms-quarantine-session-experimental-pg.test.ts'
        elif database == 'voipgw_quarantine_test_run3':
            env['VOIPGW_QUARANTINE_ROUNDTRIP_TEST_DATABASE_URL'] = url
            env['VOIPGW_QUARANTINE_ROUNDTRIP_TEST_ENABLE'] = 'yes'
            test = 'test/sms-quarantine-roundtrip-experimental-pg.test.ts'
        elif database in ('voipgw_quarantine_test', 'voipgw_quarantine_test_run2'):
            env['VOIPGW_QUARANTINE_TEST_DATABASE_URL'] = url
            env['VOIPGW_QUARANTINE_TEST_ENABLE'] = 'yes'
            test = 'test/sms-quarantine-writer-experimental-pg.test.ts'
        else:
            env['VOIPGW_TEST_DATABASE_URL'] = url
            test = 'test/postgres-isolated.integration.test.ts'
        result = subprocess.run([r'E:\dev\sandbox\VOIP\.toolchain\node\node.exe', 'node_modules/vitest/vitest.mjs', 'run', test], cwd=r'E:\dev\sandbox\VOIP\core', env=env, timeout=90)
        server.shutdown()
        sys.exit(result.returncode)
finally:
    client.close()
