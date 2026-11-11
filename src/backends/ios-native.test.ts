// Python sidecar tests import modules only; no device, tunnel or daemon is opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pymd3Python } from './pymd3-python.ts';
const py = pymd3Python();
if (process.env.PHONEDOCK_REQUIRE_SIDECAR_TESTS === '1' && !py) throw new Error('CI requires pymobiledevice3 Python for sidecar tests');
const program = String.raw`
import asyncio, importlib.util, io, json, sys, types
p = sys.argv[1]
spec = importlib.util.spec_from_file_location('pd_native', p)
n = importlib.util.module_from_spec(spec); sys.modules[spec.name] = n; spec.loader.exec_module(n)
def snapshot(items, count=1): return {'pasteboard': {'items':items, 'metadata':{'nonce':'session','changeCount':count}}}
plain={'types':['public.utf8-plain-text','public.text'],'data':{'public.utf8-plain-text':{'data':b'old'},'public.text':{'isPromised':True}}}
assert n.clip_restore_items(snapshot([plain]))[0]['data']['public.text']['data']==b'old'
assert n.clip_restore_items(snapshot([]))==[]
assert n.clip_text(snapshot([{'types':['public.utf8-plain-text'],'data':{'public.utf8-plain-text':{'data':b''}}}]))==''
assert n.clip_restore_items(snapshot([{'types':['public.rtf'],'data':{'public.rtf':{'isPromised':True}}}])) is None
assert n.clip_change_id(snapshot([],1))!=n.clip_change_id(snapshot([],2))
assert n.clip_change_id({'pasteboard':{'items':[]}}) is None
async def main():
 server=n.Server(io.StringIO(),'pdtest-fake','auto','small',False)
 await server.session.ensure()
 a=await server.c_clipboard_begin({'text':'secret-密码','secret':True})
 assert a['restorable'] is True
 await server.session.api.clipboard_set('user copy')
 r=await server.c_clipboard_finish({'token':a['token'],'confirmed':True})
 assert r['restored'] is False and r['reason']=='clipboard_changed'
 assert await server.session.api.clipboard_get()=='user copy'
 a=await server.c_clipboard_begin({'text':'café','secret':True})
 r=await server.c_clipboard_finish({'token':a['token'],'confirmed':True})
 assert r['restored'] is True
 assert await server.session.api.clipboard_get()=='user copy'
 a=await server.c_clipboard_begin({'text':'café','secret':True})
 r=await server.c_clipboard_finish({'token':a['token'],'confirmed':False})
 assert r['restored'] is False and await server.session.api.clipboard_get()=='café'
 # The general sidecar must never replay a gesture after a dropped connection.
 calls=[]
 async def steps(_): calls.append(1); raise n.SidecarError('connection_lost','lost after input')
 async def ensure(): pass
 async def dims(_): return (100,200)
 server.session.run_steps=steps;server.session.ensure=ensure;server.session.screen_dims=dims
 server.session.api=types.SimpleNamespace(fake=False)
 try: await server.c_tap({'x':10,'y':10})
 except n.SidecarError: pass
 assert len(calls)==1, calls
asyncio.run(main())
print('ok')
`;
test('native sidecar clipboard generations/restoration and no gesture replay', { skip: !py }, () => {
  const r = spawnSync(py!, ['-I', '-B', '-c', program, resolve('tools/pd-ios-native.py')], { timeout: 10000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(r.status, 0, r.stderr.toString()); assert.match(r.stdout.toString(), /ok/);
});

test('HID pinch reports two simultaneous contacts and releases both', { skip: !py }, () => {
  const r = spawnSync(py!, ['-I','-B','-c',String.raw`
import asyncio, importlib.util, sys, types
spec=importlib.util.spec_from_file_location('pd_hid',sys.argv[1]);n=importlib.util.module_from_spec(spec);spec.loader.exec_module(n)
async def main():
 reports=[]
 class Touch:
  async def send_multitouch(self, contacts): reports.append(contacts)
 ch=object.__new__(n.Channel);ch.stream=types.SimpleNamespace(hid=Touch())
 await ch.pinch(32768,32768,2,0.001)
 assert len(reports)>=3
 assert all(len(r)==2 and r[0].identity!=r[1].identity for r in reports)
 assert all(c.touching for c in reports[0]) and not any(c.touching for c in reports[-1])
 assert abs(reports[0][0].x-reports[0][1].x)<abs(reports[-1][0].x-reports[-1][1].x)
 try: await ch.pinch(1,1,float('nan'),1)
 except ValueError: pass
 else: raise AssertionError('invalid scale accepted')
asyncio.run(main())
print('ok')
`,resolve('tools/pd-ios-hid.py')],{timeout:10000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(r.status,0,r.stderr.toString());assert.match(r.stdout.toString(),/ok/);
});

test('native JSON-lines client: clipboard transaction and appearance use the fake sidecar only', { skip: !py }, async () => {
  const saved = process.env.PD_IOS_NATIVE_FAKE;
  process.env.PD_IOS_NATIVE_FAKE = '320x640@2';
  const { nativeSession, closeAllNativeSessions, nativeAvailability } = await import('./ios-native.ts');
  try {
    const available = await nativeAvailability(); assert.equal(available.ok, true, available.reason ?? '');
    const session = nativeSession('pdtest-protocol-only');
    const tree = await session.uiTree();
    assert.equal(typeof tree.generation, 'number'); assert.equal(tree.complete, true);
    assert.equal(tree.app?.pid, 100); assert.equal(tree.app?.label, 'Fake App');
    assert.equal(await session.appearance(), 'light');
    assert.equal(await session.appearance('dark'), 'dark');
    await session.clipboardSet('before');
    const begun = await session.clipboardBegin('password-密码', true);
    assert.equal(await session.clipboardGet(), 'password-密码');
    assert.deepEqual(await session.clipboardFinish(begun.token, true), { restored: true });
    assert.equal(await session.clipboardGet(), 'before');
    const { withInputFence } = await import('../core/input-fence.ts');
    const { PhoneDockError } = await import('../core/types.ts');
    let allowed = true;
    const pending = withInputFence(() => { if (!allowed) throw new PhoneDockError('Taken over', 'lease_conflict', 409, undefined, undefined, 'not_sent'); },
      () => session.clipboardSet('must-not-send'));
    allowed = false;
    await assert.rejects(pending, (e: any) => e.code === 'lease_conflict' && e.delivery === 'not_sent');
    assert.equal(await session.clipboardGet(), 'before', 'fenced queued write changed clipboard');
    const logs = await session.logs({ appId: 'com.example.app', lines: 1 });
    assert.match(logs, /Fake device log/);
    assert.equal(await session.logs({ appId: 'com.other.app' }), '');
  } finally {
    closeAllNativeSessions();
    if (saved === undefined) delete process.env.PD_IOS_NATIVE_FAKE; else process.env.PD_IOS_NATIVE_FAKE = saved;
  }
});
