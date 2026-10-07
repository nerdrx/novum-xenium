"""Textarea measurement must preserve layout without duplicating form controls."""
import json
from pathlib import Path
import shutil
import subprocess

import pytest


def test_resize_clone_is_inert_and_tracks_changed_layout():
    if not shutil.which("node"):
        pytest.skip("node is not installed")
    source = (Path(__file__).resolve().parents[1] / "static/js/ui.js").read_text()
    start = source.index("export function autoResize(")
    end = source.index("\n/**", start)
    function = source[start:end].replace("export function", "function", 1)
    script = r'''
      const assert = require('node:assert/strict');
      const window = {innerWidth: 1280};
      let fontSize = '13px', lineHeight = '18.2px';
      const computed = {get lineHeight(){return lineHeight;}, get fontSize(){return fontSize;},
        getPropertyValue(p){return p === 'font-size' ? fontSize : p === 'line-height' ? lineHeight : 'metric';}};
      const getComputedStyle = () => computed;
      const makeStyle = () => ({values:{},setProperty(k,v){this.values[k]=v;}});
      let clones = 0;
      const textarea = {value:'first',offsetWidth:300,style:makeStyle(),parentNode:{appendChild(){}},
        cloneNode(){clones++;return {attrs:{id:'message',name:'message',required:'',autofocus:'',form:'send',
          'aria-label':'Message'},style:makeStyle(),scrollHeight:1000,
          removeAttribute(k){delete this.attrs[k];},setAttribute(k,v){this.attrs[k]=v;}};}};
      const autoResize = new Function('window','getComputedStyle',FUNCTION + '; return autoResize;')(window,getComputedStyle);
      autoResize(textarea);
      const clone = textarea._resizeClone;
      assert.equal(clone.disabled,true);
      assert.equal(clone.tabIndex,-1);
      assert.deepEqual(clone.attrs,{'aria-hidden':'true'});
      assert.equal(clone.style.values['font-size'],'13px');
      assert.equal(parseFloat(textarea.style.height),18.2*8);
      assert.equal(textarea.style.overflow,'auto');
      window.innerWidth=600;fontSize='16px';lineHeight='22.4px';textarea.offsetWidth=220;
      textarea.value='changed';autoResize(textarea);
      assert.equal(clones,1);
      assert.equal(clone.value,'changed');
      assert.equal(clone.style.values['font-size'],'16px');
      assert.equal(clone.style.values.width,'220px');
      assert.equal(textarea.style.height,'150px');
      lineHeight='normal';clone.scrollHeight=4;autoResize(textarea);
      assert.equal(parseFloat(textarea.style.height),19.2);
      assert.equal(textarea.style.overflow,'hidden');
    '''.replace("FUNCTION", json.dumps(function))
    result = subprocess.run(["node", "-e", script], capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr
