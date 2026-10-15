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
parser.add_argument('--browser-probe', action='store_true', help='capture an external link with an isolated fake host opener')
parser.add_argument('--tray-host', choices=('none', 'fake'), help='optional isolated close/tray test; needs dbus-run-session, dbus-python/GLib, python-xlib and xdotool')
parser.add_argument('--notification-probe', action='store_true', help='test notification click routing with a private fake D-Bus notification server')
options = parser.parse_args()

# Never touch the user's session bus in this opt-in lifecycle test.
if (options.tray_host or options.notification_probe) and not os.environ.get('NX_NATIVE_SMOKE_PRIVATE_BUS'):
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

class FakeNotifications:
    def __init__(self):
        import dbus
        import dbus.service
        from dbus.mainloop.glib import DBusGMainLoop
        from gi.repository import GLib
        DBusGMainLoop(set_as_default=True)
        self.bus = dbus.SessionBus()
        self.name = dbus.service.BusName('org.freedesktop.Notifications', self.bus, do_not_queue=True)
        self.notifications = []
        self.ready = threading.Condition()
        owner = self
        class Server(dbus.service.Object):
            def __init__(server): super().__init__(owner.bus, '/org/freedesktop/Notifications')
            @dbus.service.method('org.freedesktop.Notifications', in_signature='', out_signature='as')
            def GetCapabilities(server): return dbus.Array(['actions', 'body'], signature='s')
            @dbus.service.method('org.freedesktop.Notifications', in_signature='', out_signature='ssss')
            def GetServerInformation(server): return ('Novum test server', 'Codex', '1', '1.2')
            @dbus.service.method('org.freedesktop.Notifications', in_signature='susssasa{sv}i', out_signature='u')
            def Notify(server, app_name, replaces_id, app_icon, summary, body, actions, hints, timeout):
                with owner.ready:
                    notification_id = len(owner.notifications) + 1
                    owner.notifications.append({'id': notification_id, 'summary': str(summary), 'actions': list(actions)})
                    owner.ready.notify_all()
                return dbus.UInt32(notification_id)
            @dbus.service.method('org.freedesktop.Notifications', in_signature='u', out_signature='')
            def CloseNotification(server, notification_id): return
            @dbus.service.signal('org.freedesktop.Notifications', signature='us')
            def ActionInvoked(server, notification_id, action): return
        self.object = Server()
        self.loop = GLib.MainLoop()
        self.thread = threading.Thread(target=self.loop.run, daemon=True)
        self.thread.start()
    def wait_for(self, index):
        deadline = time.monotonic() + 10
        with self.ready:
            while len(self.notifications) <= index and time.monotonic() < deadline:
                self.ready.wait(max(0, deadline - time.monotonic()))
            assert len(self.notifications) > index, 'desktop app did not send a D-Bus notification'
            return self.notifications[index]
    def click(self, notification_id, action):
        import dbus
        # Retry briefly so the native listener has subscribed after Notify returns.
        for _ in range(5):
            self.object.ActionInvoked(dbus.UInt32(notification_id), dbus.String(action))
            time.sleep(.1)
    def close(self):
        self.loop.quit()
        self.thread.join(timeout=2)

private_config = tempfile.TemporaryDirectory(prefix='novum-native-config-')
private_runtime = tempfile.TemporaryDirectory(prefix='novum-native-runtime-') if options.tray_host else None
app_env = {**os.environ, 'XDG_CONFIG_HOME':private_config.name}
if options.browser_probe:
    probe_bin = Path(private_config.name) / 'bin'
    probe_bin.mkdir()
    browser_capture = Path(private_config.name) / 'browser-launch.json'
    opener = probe_bin / 'xdg-open'
    opener.write_text('#!/usr/bin/python3\nimport os,json,sys\nfrom pathlib import Path\nPath(' + repr(str(browser_capture)) + ').write_text(json.dumps({"args":sys.argv[1:],"library":os.environ.get("LD_LIBRARY_PATH",""),"appdir":os.environ.get("APPDIR","")}))\n')
    opener.chmod(0o755)
    app_env['PATH'] = str(probe_bin) + os.pathsep + app_env['PATH']

if private_runtime:
    app_env.update(XDG_RUNTIME_DIR=private_runtime.name,
                   XDG_DATA_HOME=str(Path(private_runtime.name) / 'data'),
                   XDG_CACHE_HOME=str(Path(private_runtime.name) / 'cache'))
port, native = free_port(), free_port()
base=f'http://127.0.0.1:{port}'
watcher = FakeStatusNotifierWatcher() if options.tray_host == 'fake' else None
notification_server = FakeNotifications() if options.notification_probe else None
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
    workbench_window = window_ids('Novum Xenium Workbench')[0] if options.tray_host == 'none' else None
    notification_session_id = None
    if notification_server:
        auth_query = "import json,time,os; from core.auth import DEFAULT_AUTH_PATH; p=os.path.join(os.path.dirname(DEFAULT_AUTH_PATH),'sessions.json'); d=json.load(open(p)); print(next(k for k,v in d.items() if v.get('expiry',0)>time.time() and v.get('username')=='admin'))"
        try:
            session_cookie = subprocess.check_output([
                'docker', 'exec', '-e', 'PYTHONPATH=/app', 'odysseus-local-odysseus-1',
                'python', '-c', auth_query,
            ], text=True, stderr=subprocess.DEVNULL).strip()
        except (OSError, subprocess.CalledProcessError) as exc:
            raise AssertionError('could not capture an existing backend session for the read-only notification probe') from exc
        assert session_cookie, 'no active admin session is available for the read-only notification probe'
        current_url = execute('return location.href')
        assert current_url.startswith(f'http://127.0.0.1:{options.backend_port}/'), 'workbench is not on the configured backend origin'
        call('POST', prefix + '/cookie', {'cookie': {
            'name': 'odysseus_session', 'value': session_cookie, 'path': '/',
            'httpOnly': True, 'secure': False, 'sameSite': 'Lax',
        }})
        del session_cookie
        before = execute('return performance.timeOrigin')
        execute('window.location.reload()')
        for _ in range(100):
            try:
                if execute('return performance.timeOrigin') != before: break
            except Exception:
                pass
            time.sleep(.1)
        else:
            raise AssertionError('authenticated workbench did not reload')
        for _ in range(100):
            notification_session_id = execute("return window.sessionModule?.getSessions()?.find(s => s && typeof s.id === 'string' && s.id.length > 0 && s.archived !== true)?.id || null")
            if notification_session_id: break
            time.sleep(.1)
        assert notification_session_id, 'authenticated workbench has no existing chat to restore'
        assert execute('return window.sessionModule.getSessions().some(s => s.id === arguments[0])', [notification_session_id]), 'selected chat is absent from the signed-in session list'
    result=call('POST',prefix+'/execute/async',{'script':"const done=arguments[arguments.length-1]; if(!window.__TAURI__?.core?.invoke){done({blocked:true});}else{window.__TAURI__.core.invoke('get_status').then(()=>done({blocked:false}),e=>done({blocked:true,error:String(e)}));}",'args':[]})
    assert result['blocked'],result
    if notification_server:
        execute("localStorage.setItem('nx.desktopNotifications','true'); window.__nxNotificationHash=null; window.addEventListener('hashchange',()=>window.__nxNotificationHash=location.hash);")
        notification_tag = 'stream-' + notification_session_id
        execute('new Notification("Response Complete",{body:"probe",tag:' + json.dumps(notification_tag) + '});')
        unknown_action = notification_server.wait_for(0)
        assert 'default' in unknown_action['actions'], unknown_action
        notification_server.click(unknown_action['id'], 'open-url')
        time.sleep(.25)
        assert execute('return window.__nxNotificationHash') is None, 'unknown notification action changed the workbench route'
        time.sleep(1.05)  # The native route deliberately limits delivery to one notification per second.
        execute('new Notification("Response Complete",{body:"probe",tag:' + json.dumps(notification_tag) + '});')
        default_action = notification_server.wait_for(1)
        notification_server.click(default_action['id'], 'default')
        for _ in range(100):
            if execute('return window.__nxNotificationHash') == '#' + notification_session_id: break
            time.sleep(.1)
        assert execute('return window.__nxNotificationHash') == '#' + notification_session_id, 'default notification click did not route to the tagged chat'
        for _ in range(100):
            if execute('return window.sessionModule?.getCurrentSessionId()') == notification_session_id: break
            time.sleep(.1)
        assert execute('return window.sessionModule?.getCurrentSessionId()') == notification_session_id, 'default notification click did not restore the existing signed-in chat'
        print('PASS: private D-Bus default click restored an existing chat from the signed-in session list', flush=True)
    def wait_for_reload(before):
        for _ in range(100):
            try:
                if execute('return performance.timeOrigin') != before:
                    return
            except Exception:
                pass  # The document may be between navigation and creation.
            time.sleep(.1)
        raise AssertionError('workspace did not reload')

    if not options.browser_probe:
        for key_event in [
            {'key': 'r', 'ctrlKey': True, 'bubbles': True, 'cancelable': True},
            {'key': 'F5', 'bubbles': True, 'cancelable': True},
        ]:
            before = execute('return performance.timeOrigin')
            execute('document.dispatchEvent(new KeyboardEvent("keydown", ' + json.dumps(key_event) + '))')
            wait_for_reload(before)
        if watcher:
            before = execute('return performance.timeOrigin')
            watcher.click_menu_item('Reload workspace')
            wait_for_reload(before)
        print('PASS: native workspace Ctrl+R, F5 and available tray reload', flush=True)
    print('PASS: native config/status/logs/workbench; remote management blocked',flush=True)
    if options.browser_probe:
        for _ in range(100):
            if execute("return ['custom', 'native'].includes(document.documentElement.dataset.nxWindowFrame)"): break
            time.sleep(.1)
        assert execute("return ['custom', 'native'].includes(document.documentElement.dataset.nxWindowFrame)"), 'window frame did not initialize'
        probe_url = 'https://example.com/?a=1&b=2'
        execute('window.location.href=' + json.dumps(probe_url))
        for _ in range(100):
            if browser_capture.exists(): break
            time.sleep(.1)
        captured = json.loads(browser_capture.read_text())
        assert captured['args'] == [probe_url], captured
        assert captured['appdir'] and captured['appdir'] not in captured['library'], captured
        print('PASS: native external link reaches host opener without bundled libraries', flush=True)

    if options.tray_host == 'none':
        workbench_ids=[workbench_window]
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
        if notification_server: notification_server.close()
        if private_runtime: private_runtime.cleanup()
        private_config.cleanup()

if smoke_ok:
    try:
        if options.tray_host: run_tray_lifecycle()
    finally:
        if watcher: watcher.close()
        if notification_server: notification_server.close()
        if private_runtime: private_runtime.cleanup()
        private_config.cleanup()
