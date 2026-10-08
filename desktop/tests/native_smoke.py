import argparse, json, os, subprocess, tempfile, time, urllib.request, socket, base64, sys, threading
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
parser.add_argument('--tray-host', choices=('none', 'fake'), help='optional isolated close/tray test; needs dbus-run-session, dbus-python/GLib, python-xlib and xdotool')
options = parser.parse_args()

# Never touch the user's session bus in this opt-in lifecycle test.
if options.tray_host and not os.environ.get('NX_NATIVE_SMOKE_PRIVATE_BUS'):
    env = {**os.environ, 'NX_NATIVE_SMOKE_PRIVATE_BUS': '1'}
    result = subprocess.run(['dbus-run-session', '--', sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]], env=env)
    raise SystemExit(result.returncode)

class FakeStatusNotifierWatcher:
    def __init__(self):
        import dbus
        import dbus.service
        from dbus.mainloop.glib import DBusGMainLoop
        from gi.repository import GLib

        DBusGMainLoop(set_as_default=True)
        self.bus = dbus.SessionBus()
        self.name = dbus.service.BusName('org.kde.StatusNotifierWatcher', self.bus, do_not_queue=True)
        self.items = []
        self.ready = threading.Event()
        self.bus.add_signal_receiver(self._name_owner_changed, signal_name='NameOwnerChanged', dbus_interface='org.freedesktop.DBus')

        class Watcher(dbus.service.Object):
            def __init__(watcher):
                super().__init__(owner.bus, '/StatusNotifierWatcher')

            @dbus.service.method('org.kde.StatusNotifierWatcher', in_signature='s', out_signature='', sender_keyword='sender')
            def RegisterStatusNotifierItem(watcher, service, sender=None):
                sender = str(sender or '')
                service = str(service)
                owner.items.append((service, sender))
                watcher.StatusNotifierItemRegistered(sender + service if service.startswith('/') else service)
                owner.ready.set()

            @dbus.service.method('org.kde.StatusNotifierWatcher', in_signature='s', out_signature='')
            def RegisterStatusNotifierHost(watcher, service):
                return

            @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='ss', out_signature='v')
            def Get(watcher, interface, prop):
                if interface != 'org.kde.StatusNotifierWatcher':
                    raise dbus.exceptions.DBusException('Unknown interface')
                values = watcher.properties()
                if prop not in values:
                    raise dbus.exceptions.DBusException('Unknown property')
                return values[prop]

            @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='s', out_signature='a{sv}')
            def GetAll(watcher, interface):
                return watcher.properties() if interface == 'org.kde.StatusNotifierWatcher' else {}

            def properties(watcher):
                return {
                    'RegisteredStatusNotifierItems': dbus.Array([item[1] + item[0] if item[0].startswith('/') else item[0] for item in owner.items], signature='s', variant_level=1),
                    'IsStatusNotifierHostRegistered': dbus.Boolean(True, variant_level=1),
                    'ProtocolVersion': dbus.Int32(0, variant_level=1),
                }

            @dbus.service.signal('org.kde.StatusNotifierWatcher', signature='s')
            def StatusNotifierItemRegistered(watcher, service):
                return

            @dbus.service.signal('org.kde.StatusNotifierWatcher', signature='s')
            def StatusNotifierItemUnregistered(watcher, service):
                return

        owner = self
        self.object = Watcher()
        self.loop = GLib.MainLoop()
        self.thread = threading.Thread(target=self.loop.run, daemon=True)
        self.thread.start()

    def _name_owner_changed(self, name, old_owner, new_owner):
        if not old_owner or new_owner:
            return
        removed = [item for item in self.items if item[1] == str(name)]
        if removed:
            self.items[:] = [item for item in self.items if item not in removed]
            if not self.items:
                self.ready.clear()
            for service, sender in removed:
                full_name = sender + service if service.startswith('/') else service
                self.object.StatusNotifierItemUnregistered(full_name)

    def close(self):
        self.loop.quit()
        self.thread.join(timeout=2)

    def host_present(self):
        import dbus
        obj = self.bus.get_object('org.freedesktop.DBus', '/org/freedesktop/DBus')
        return bool(dbus.Interface(obj, 'org.freedesktop.DBus').NameHasOwner('org.kde.StatusNotifierWatcher'))

    def stop_host(self):
        self.bus.release_name('org.kde.StatusNotifierWatcher')

    def click_menu_item(self, label):
        import dbus
        deadline = time.monotonic() + 10
        while not self.items and time.monotonic() < deadline:
            self.ready.wait(.1)
        assert self.items, 'application did not register a StatusNotifierItem'
        service, sender = self.items[-1]
        if service.startswith('/'):
            bus_name, item_path = sender, service
        else:
            bus_name, item_path = service, '/StatusNotifierItem'
        item = self.bus.get_object(bus_name, item_path)
        menu_path = dbus.Interface(item, 'org.freedesktop.DBus.Properties').Get('org.kde.StatusNotifierItem', 'Menu')
        menu = dbus.Interface(self.bus.get_object(bus_name, menu_path), 'com.canonical.dbusmenu')
        layout = menu.GetLayout(0, -1, [])[1]

        def find(node):
            node_id, props, children = node
            if str(props.get('label', '')) == label:
                return int(node_id)
            for child in children:
                match = find(child)
                if match is not None:
                    return match
            return None

        item_id = find(layout)
        assert item_id is not None, f'tray menu item {label!r} is missing'
        menu.Event(item_id, 'clicked', dbus.String('', variant_level=1), dbus.UInt32(0))

    def item_owner_alive(self):
        import dbus
        assert self.items, 'no tray item has registered'
        sender = self.items[-1][1]
        dbus_obj = self.bus.get_object('org.freedesktop.DBus', '/org/freedesktop/DBus')
        return bool(dbus.Interface(dbus_obj, 'org.freedesktop.DBus').NameHasOwner(sender))

    def item_owner_pid(self):
        import dbus
        sender = self.items[-1][1]
        dbus_obj = self.bus.get_object('org.freedesktop.DBus', '/org/freedesktop/DBus')
        return int(dbus.Interface(dbus_obj, 'org.freedesktop.DBus').GetConnectionUnixProcessID(sender))

private_config = tempfile.TemporaryDirectory(prefix='novum-native-config-')
private_runtime = tempfile.TemporaryDirectory(prefix='novum-native-runtime-') if options.tray_host else None
app_env = {**os.environ, 'XDG_CONFIG_HOME':private_config.name}
if private_runtime:
    app_env.update(XDG_RUNTIME_DIR=private_runtime.name,
                   XDG_DATA_HOME=str(Path(private_runtime.name) / 'data'),
                   XDG_CACHE_HOME=str(Path(private_runtime.name) / 'cache'))
port, native = free_port(), free_port()
base=f'http://127.0.0.1:{port}'
watcher = FakeStatusNotifierWatcher() if options.tray_host == 'fake' else None
def call(method,path,data=None):
    payload=None if data is None else json.dumps(data).encode()
    req=urllib.request.Request(base+path,data=payload,method=method,headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=60) as r:
        obj=json.load(r)
    value=obj.get('value')
    if isinstance(value,dict) and value.get('error') and 'blocked' not in value: raise RuntimeError(value)
    return value

def window_ids(title):
    return subprocess.run(['xdotool','search','--onlyvisible','--name',f'^{title}$'],capture_output=True,text=True).stdout.splitlines()

def wait_for_window(title, visible=True):
    for _ in range(100):
        ids = window_ids(title)
        if bool(ids) == visible:
            return ids
        time.sleep(.1)
    raise AssertionError(f'window {title!r} did not become {"visible" if visible else "hidden"}')

def request_close(window):
    # Gamescope's headless Xwayland has no WM to relay _NET_CLOSE_WINDOW.
    from Xlib import X, display as xdisplay
    from Xlib.protocol import event
    display = xdisplay.Display()
    native_window = display.create_resource_object('window', int(window))
    protocols = native_window.get_wm_protocols() or []
    delete = display.intern_atom('WM_DELETE_WINDOW')
    assert delete in protocols, 'native window does not accept WM_DELETE_WINDOW'
    native_window.send_event(event.ClientMessage(window=native_window, client_type=display.intern_atom('WM_PROTOCOLS'), data=(32, [delete, X.CurrentTime, 0, 0, 0])), event_mask=X.NoEventMask, propagate=False)
    display.flush()
    display.close()

def run_tray_lifecycle():
    app_log = open(Path(private_runtime.name) / 'native-app.log', 'w+')
    app = subprocess.Popen([str(Path(options.application).resolve())], env=app_env, stdout=app_log, stderr=app_log)
    try:
        wait_for_window('Novum Xenium')
        if not watcher:
            request_close(window_ids('Novum Xenium')[0])
            app.wait(timeout=10)
            assert not window_ids('Novum Xenium'), 'manager stayed visible without a StatusNotifierWatcher'
            print('PASS: close exits normally without a StatusNotifierWatcher',flush=True)
            return

        assert watcher.ready.wait(10), 'application did not register its tray item'
        print('fake watcher registration:', watcher.items, 'owner pid:', watcher.item_owner_pid(), flush=True)
        request_close(window_ids('Novum Xenium')[0])
        wait_for_window('Novum Xenium', visible=False)
        assert app.poll() is None and watcher.item_owner_alive(), 'manager or tray item exited instead of staying alive while hidden'
        watcher.click_menu_item('Backend manager')
        wait_for_window('Novum Xenium')

        watcher.click_menu_item('Open workspace')
        workbench = wait_for_window('Novum Xenium Workbench')[0]
        request_close(workbench)
        wait_for_window('Novum Xenium Workbench', visible=False)
        assert app.poll() is None, 'closing the workbench exited the tray app'
        watcher.click_menu_item('Open workspace')
        assert wait_for_window('Novum Xenium Workbench')[0] == workbench, 'tray did not restore the same workbench window'

        request_close(window_ids('Novum Xenium')[0])
        wait_for_window('Novum Xenium', visible=False)
        duplicate = subprocess.Popen([str(Path(options.application).resolve())], env=app_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            duplicate.wait(timeout=10)
        except subprocess.TimeoutExpired:
            duplicate.kill(); duplicate.wait()
            raise AssertionError('second application instance did not hand off and exit')
        assert len(watcher.items) == 1, f'single-instance launch registered duplicate tray item: {watcher.items}'
        wait_for_window('Novum Xenium')
        watcher.click_menu_item('Quit')
        try: app.wait(timeout=10)
        except subprocess.TimeoutExpired:
            app_log.flush()
            app_log.seek(0)
            raise AssertionError(f'tray Quit did not exit the app; native log: {app_log.read()[-2000:]}')
        assert not watcher.items, 'tray Quit did not remove the registered item'
        watcher.ready.clear()
        loss_log = open(Path(private_runtime.name) / 'tray-loss-app.log', 'w+')
        loss_app = subprocess.Popen([str(Path(options.application).resolve())], env=app_env, stdout=loss_log, stderr=loss_log)
        try:
            wait_for_window('Novum Xenium')
            assert watcher.ready.wait(10) and watcher.items, 'second app did not register while the tray host was present'
            watcher.stop_host()
            assert not watcher.host_present(), 'fake host name remained registered after withdrawal'
            request_close(window_ids('Novum Xenium')[0])
            loss_app.wait(timeout=10)
            assert not window_ids('Novum Xenium'), 'window close hid the app after its tray host disappeared'
        finally:
            if loss_app.poll() is None:
                loss_app.terminate()
                try: loss_app.wait(timeout=5)
                except subprocess.TimeoutExpired: loss_app.kill(); loss_app.wait()
            loss_log.close()
        print('PASS: tray hide/restore reuses both windows; second launch focuses existing instance; Quit exits; vanished host disables hide',flush=True)
    finally:
        if app.poll() is None:
            app.terminate()
            try: app.wait(timeout=5)
            except subprocess.TimeoutExpired: app.kill(); app.wait()
        app_log.close()

p=subprocess.Popen([options.driver,'--port',str(port),'--native-port',str(native)], env=app_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
session=None
smoke_ok=False
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
    controls_ready = """const dashboard=document.querySelector('.dashboard-grid');
      return dashboard.getAttribute('aria-busy') === 'false'
        && !document.querySelector('[data-action=refresh]').disabled
        && !document.querySelector('[data-action=open]').disabled
        && !document.querySelector('[data-action=stop]').disabled;"""
    for _ in range(100):
        if execute(controls_ready): break
        time.sleep(.1)
    assert execute(controls_ready), 'dashboard stayed busy or left running-service controls disabled'
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
    if options.tray_host == 'none':
        workbench_ids=window_ids('Novum Xenium Workbench')
        owned_pids=[int(subprocess.check_output(['xdotool','getwindowpid',window],text=True).strip()) for window in workbench_ids + window_ids('Novum Xenium')]
        for window in workbench_ids: request_close(window)
        if workbench_ids: wait_for_window('Novum Xenium Workbench',visible=False)
        time.sleep(.1)
        for window in window_ids('Novum Xenium'): request_close(window)
        for pid in owned_pids:
            for _ in range(100):
                try: os.kill(pid,0)
                except ProcessLookupError: break
                time.sleep(.1)
            else: raise AssertionError(f'window close without tray host left native app PID {pid} running')
    if options.tray_host == 'fake':
        assert watcher.ready.wait(10), 'driver-launched app did not register its tray item'
        watcher.click_menu_item('Quit')
        for _ in range(100):
            if not watcher.items: break
            time.sleep(.1)
        assert not watcher.items, 'driver-launched app did not quit before direct tray lifecycle test'
    smoke_ok=True
finally:
    if session:
        try:call('DELETE',f'/session/{session}')
        except Exception:pass
    p.terminate()
    try:p.wait(timeout=5)
    except subprocess.TimeoutExpired:p.kill();p.wait()
    if not smoke_ok:
        if watcher: watcher.close()
        if private_runtime: private_runtime.cleanup()
        private_config.cleanup()

if smoke_ok:
    try:
        if options.tray_host: run_tray_lifecycle()
    finally:
        if watcher: watcher.close()
        if private_runtime: private_runtime.cleanup()
        private_config.cleanup()
