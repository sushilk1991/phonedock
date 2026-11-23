import pathlib,json,subprocess,os,time,signal,sys,statistics,plistlib
repo=pathlib.Path.cwd();root=pathlib.Path(os.environ['PHONEDOCK_PERF_DIR']);label=sys.argv[1];duration=int(sys.argv[2]) if len(sys.argv)>2 else 300
id='ios-simulator:'+json.loads((root/'device.json').read_text())['udid']
script=root/(label+'-selftest.json');log=root/(label+'-selftest.log');perf=root/(label+'-app-perf.jsonl');stderr=root/(label+'-app-stderr.log')
steps=[{'op':'windowSize','w':1280,'h':840},{'op':'inspector','show':True},{'op':'select','device':id},{'op':'wait','ms':10000},{'op':'perf','label':'polls-before','reset':True}]
for i in range(10):steps.extend([{'op':'refresh'},{'op':'wait','ms':300}])
steps.extend([{'op':'perf','label':'polls-after','reset':True},{'op':'screenshot','path':str(root/(label+'-window.png')),'render':True},{'op':'mark','text':'live-start'},{'op':'wait','ms':duration*1000},{'op':'perf','label':'live-end','reset':True},{'op':'mark','text':'live-end'},{'op':'stallFrames'},{'op':'wait','ms':6500},{'op':'mark','text':'idle-start'},{'op':'wait','ms':30000},{'op':'mark','text':'idle-end'},{'op':'perf','label':'idle-end'}])
steps.append({'op':'screenshot','path':str(root/(label+'-window-server.png'))})
script.write_text(json.dumps({'steps':steps}));log.unlink(missing_ok=True);perf.unlink(missing_ok=True)
backup=root/(label+'-preferences.plist');subprocess.run(['defaults','export','dev.phonedock.app',str(backup)],check=True)
values={'PHONEDOCK_APP_SELFTEST':str(script),'PHONEDOCK_APP_SELFTEST_LOG':str(log),'PHONEDOCK_APP_SELFTEST_QUIT':'1','PHONEDOCK_APP_PERF':str(perf),'PHONEDOCK_PERF_LOG':'1','PHONEDOCK_SELECT':id,'PHONEDOCK_APP_TAB':'info','PHONEDOCK_PORT':'47433','PHONEDOCK_HOME':str(root/'home'),'PHONEDOCK_DEVICE_FILTER':'pdtest-'}
args=['open','-g','-n','-F','--stdout',str(stderr),'--stderr',str(stderr)]
for k,v in values.items():args+=['--env',k+'='+v]
args+=[str(root/'PhoneDock.app')]
samples=[];pid=None;phase='startup';sample_job=None;launch=time.time();start=time.monotonic();result={}
def proc(p):
 try:
  a=subprocess.check_output(['ps','-p',str(p),'-o','time=,rss='],text=True).split();t=0
  for n in a[0].split(':'):t=t*60+float(n)
  return {'cpuSeconds':t,'rssKiB':int(a[1])}
 except subprocess.CalledProcessError:return None
try:
 subprocess.run(args,check=True)
 for i in range(duration+140):
  if pid is None:
   for line in subprocess.check_output(['ps','-axo','pid=,comm='],text=True).splitlines():
    if line.strip().endswith(str(root/'PhoneDock.app/Contents/MacOS/PhoneDock')):pid=int(line.split()[0]);break
  text=log.read_text() if log.exists() else ''
  if 'MARK idle-end' in text:phase='done'
  elif 'MARK idle-start' in text:phase='idle'
  elif 'MARK live-end' in text:phase='settle'
  elif 'MARK live-start' in text:phase='live'
  p=proc(pid) if pid else None
  if p:samples.append({'elapsed':time.monotonic()-start,'phase':phase,**p})
  if phase=='live' and sample_job is None:
   sample_job=subprocess.Popen(['/usr/bin/sample',str(pid),'5','10','-file',str(root/(label+'-app.sample.txt'))],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  if 'DONE' in text:break
  time.sleep(1)
 else:raise RuntimeError('App self-test timed out')
 if 'failure(s)' in text or 'FAIL' in text:raise RuntimeError('Self-test failed: '+text[-2500:])
 result={'label':label,'pid':pid,'launchAt':launch,'samples':samples,'log':str(log),'perf':str(perf)}
 if not perf.exists():raise RuntimeError('Missing required performance counters')
 if perf.exists():
  records=[json.loads(l) for l in perf.read_text().splitlines()];result['bodyCounters']=records
  required={'firstDevices','polls-before','polls-after','live-end','idle-end'}
  if not required.issubset({r['label'] for r in records}):raise RuntimeError('Incomplete performance counters')
  first=next((r for r in records if r['label']=='firstDevices'),None)
  if first:result['launchToFirstDevicesMs']=(first['time']-launch)*1000
 for ph in ['live','idle']:
  a=[s for s in samples if s['phase']==ph]
  if len(a)>2:
   # Exclude 10 s start-up (live also includes the sample's 5 s) from CPU; retain full memory timeline.
   stable=[s for s in a if s['elapsed']-a[0]['elapsed']>=10]
   result[ph]={'cpuPercent':(stable[-1]['cpuSeconds']-stable[0]['cpuSeconds'])/(stable[-1]['elapsed']-stable[0]['elapsed'])*100,'rssStartKiB':a[0]['rssKiB'],'rssEndKiB':a[-1]['rssKiB'],'rssPeakKiB':max(s['rssKiB'] for s in a),'durationSeconds':a[-1]['elapsed']-a[0]['elapsed']}
 print(json.dumps({k:v for k,v in result.items() if k not in ['samples','bodyCounters']},indent=2))
except BaseException as e:
 result.update({'error':str(e),'samples':samples});raise
finally:
 if pid and proc(pid):
  os.kill(pid,signal.SIGTERM)
  for _ in range(40):
   if proc(pid) is None:break
   time.sleep(.1)
 if sample_job:sample_job.wait(timeout=20)
 subprocess.run(['defaults','delete','dev.phonedock.app'],check=True,stdout=subprocess.DEVNULL)
 subprocess.run(['defaults','import','dev.phonedock.app',str(backup)],check=True,stdout=subprocess.DEVNULL)
 restored=root/(label+'-preferences-restored.plist');subprocess.run(['defaults','export','dev.phonedock.app',str(restored)],check=True)
 result['preferencesRestored']=plistlib.loads(backup.read_bytes())==plistlib.loads(restored.read_bytes())
 (root/(label+'-app.json')).write_text(json.dumps(result,indent=2))
 if not result['preferencesRestored']:raise RuntimeError('Preferences did not restore exactly')
