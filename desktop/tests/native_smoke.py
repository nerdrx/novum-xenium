import argparse, json, os, subprocess, tempfile, time, urllib.request, socket, base64
from pathlib import Path

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0)); return s.getsockname()[1]
parser = argparse.ArgumentParser(description="Read-only native IPC smoke against an existing healthy backend. Run inside a headless compositor.")
parser.add_argument('--application', required=True)
parser.add_argument('--checkout', required=True)
parser.add_argument('--project', required=True)
parser.add_argument('--backend-port', type=int, default=7000)
parser.add_argument('--driver', default='tauri-driver')
parser.add_argument('--screenshot')
options = parser.parse_args()
private_config = tempfile.TemporaryDirectory(prefix='novum-native-config-')
port, native = free_port(), free_port()
base=f'http://127.0.0.1:{port}'
def call(method,path,data=None):
    payload=None if data is None else json.dumps(data).encode()
    req=urllib.request.Request(base+path,data=payload,method=method,headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=60) as r:
        obj=json.load(r)
    value=obj.get('value')
    if isinstance(value,dict) and value.get('error') and 'blocked' not in value: raise RuntimeError(value)
    return value
p=subprocess.Popen([options.driver,'--port',str(port),'--native-port',str(native)], env={**os.environ, 'XDG_CONFIG_HOME':private_config.name}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
session=None
try:
    for _ in range(100):
        try: call('GET','/status'); break
        except Exception: time.sleep(.1)
    v=call('POST','/session',{'capabilities':{'alwaysMatch':{'browserName':'wry','tauri:options':{'application':str(Path(options.application).resolve())}}}})
    session=v['sessionId']; prefix=f'/session/{session}'
    def execute(script,args=[]): return call('POST',prefix+'/execute/sync',{'script':script,'args':args})
    def invoke(command,args={}):
        v=call('POST',prefix+'/execute/async',{'script':"const done=arguments[arguments.length-1]; window.__TAURI__.core.invoke(arguments[0],arguments[1]).then(v=>done({ok:true,value:v}),e=>done({ok:false,error:String(e)}));",'args':[command,args]})
        assert v['ok'],v
        return v['value']
    for _ in range(100):
        if execute('return !!window.__TAURI__?.core?.invoke'): break
        time.sleep(.1)
    assert invoke('get_status')['backend']['state']=='unconfigured'
    config={'checkout':str(Path(options.checkout).resolve()),'project':options.project,'port':options.backend_port}
    assert invoke('save_config',{'config':config})['project']==options.project
    status=invoke('get_status')
    print('native status:',status['backend'],flush=True)
    assert status['backend']['state']=='running',status['backend']
    logs=invoke('read_logs'); assert isinstance(logs['text'],str)
    print('native bounded logs:',len(logs['text']),'characters',flush=True)
    execute("document.querySelector('[data-action=refresh]').click()")
    for _ in range(100):
        if execute("return document.querySelector('#backend-state-text').textContent") == 'Running': break
        time.sleep(.1)
    assert execute("return document.querySelector('#backend-state-text').textContent") == 'Running'
    if options.screenshot:
        Path(options.screenshot).write_bytes(base64.b64decode(call('GET',prefix+'/screenshot')))
    invoke('open_workbench')
    handles=call('GET',prefix+'/window/handles'); assert len(handles)==2,handles
    main=call('GET',prefix+'/window')
    remote=next(h for h in handles if h!=main)
    call('POST',prefix+'/window',{'handle':remote})
    result=call('POST',prefix+'/execute/async',{'script':"const done=arguments[arguments.length-1]; if(!window.__TAURI__?.core?.invoke){done({blocked:true});}else{window.__TAURI__.core.invoke('get_status').then(()=>done({blocked:false}),e=>done({blocked:true,error:String(e)}));}",'args':[]})
    assert result['blocked'],result
    print('PASS: native config/status/logs/workbench; remote management blocked',flush=True)
finally:
    if session:
        try:call('DELETE',f'/session/{session}')
        except Exception:pass
    p.terminate()
    try:p.wait(timeout=5)
    except subprocess.TimeoutExpired:p.kill();p.wait()
    private_config.cleanup()
