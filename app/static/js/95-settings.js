    // ── 个人配置面板（服务商地址、模型、密钥与文件位置）────────
    var _settingsEntries = [];
    var _settingsBusy = false;

    function readJsonResponse(response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (ignore) { data = null; }
        if (!response.ok) {
          var detail = data && data.detail ? data.detail : ('HTTP ' + response.status);
          throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
        }
        return data;
      });
    }

    function openSettings() {
      _savedScrollY = window.scrollY;
      document.body.style.position = 'fixed';
      document.body.style.top = '-' + _savedScrollY + 'px';
      document.body.style.width = '100%';
      byId('settings-drawer').classList.add('is-open');
      byId('settings-overlay').classList.add('is-open');
      byId('settings-drawer').setAttribute('aria-hidden', 'false');
      document.body.classList.add('overlay-open');
      loadSettings();
      setTimeout(function () { byId('settings-close-btn').focus(); }, 180);
    }

    function closeSettings() {
      byId('settings-drawer').classList.remove('is-open');
      byId('settings-overlay').classList.remove('is-open');
      byId('settings-drawer').setAttribute('aria-hidden', 'true');
      document.body.classList.remove('overlay-open');
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, _savedScrollY);
      byId('settings-btn').focus();
    }

    function loadSettings() {
      var body = byId('settings-body');
      body.replaceChildren();
      var state = document.createElement('p');
      state.className = 'settings-state';
      state.textContent = '正在读取配置…';
      body.appendChild(state);
      fetch(appUrl('/api/read-podcast/settings'))
        .then(readJsonResponse)
        .then(function (data) { renderSettings(data); })
        .catch(function (error) { state.textContent = '配置读取失败：' + errorMessage(error); });
    }

    function buildSettingsField(field) {
      var wrap = document.createElement('div');
      wrap.className = 'settings-field';
      var inputId = 'setting-' + String(field.key || '').replace(/[^a-zA-Z0-9]+/g, '-');
      var isSecret = field.type === 'secret';

      var label = document.createElement('label');
      label.className = 'form-label';
      label.setAttribute('for', inputId);
      var labelText = document.createElement('span');
      labelText.textContent = String(field.label || field.key || '');
      label.appendChild(labelText);
      if (isSecret) {
        var badge = document.createElement('span');
        badge.className = 'settings-badge' + (field.configured ? ' is-set' : '');
        badge.textContent = field.configured ? '已配置' : '未配置';
        label.appendChild(badge);
      }
      wrap.appendChild(label);

      var entry = { key: String(field.key || ''), type: field.type, locked: !!field.locked, cleared: false };
      var control;
      if (field.type === 'select') {
        control = document.createElement('select');
        (field.options || []).forEach(function (option) {
          var node = document.createElement('option');
          node.value = String(option.value == null ? '' : option.value);
          node.textContent = String(option.label || option.value || '');
          control.appendChild(node);
        });
        control.value = String(field.value == null ? '' : field.value);
      } else {
        control = document.createElement('input');
        control.type = isSecret ? 'password' : 'text';
        control.autocomplete = isSecret ? 'new-password' : 'off';
        control.spellcheck = false;
        if (isSecret) control.placeholder = field.configured ? '已配置，留空表示不修改' : '尚未配置';
        else {
          control.placeholder = String(field.placeholder || '');
          control.value = String(field.value == null ? '' : field.value);
        }
      }
      control.className = 'form-input';
      control.id = inputId;
      if (field.locked) control.disabled = true;
      entry.input = control;
      // 只提交真正改动过的字段，避免把内置默认值固化进 config.yaml。
      entry.initial = isSecret ? '' : control.value;

      if (isSecret && field.configured && !field.locked) {
        var row = document.createElement('div');
        row.className = 'settings-secret-row';
        var clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'ghost-btn settings-secret-clear';
        clearBtn.textContent = '清除';
        clearBtn.addEventListener('click', function () {
          entry.cleared = !entry.cleared;
          clearBtn.textContent = entry.cleared ? '撤销' : '清除';
          control.value = '';
          control.disabled = entry.cleared;
          control.placeholder = entry.cleared ? '保存后清除' : '已配置，留空表示不修改';
        });
        row.append(control, clearBtn);
        wrap.appendChild(row);
      } else {
        wrap.appendChild(control);
      }

      var hints = [];
      if (field.locked && field.locked_reason) hints.push(String(field.locked_reason));
      if (field.hint) hints.push(String(field.hint));
      if (hints.length) {
        var hint = document.createElement('p');
        hint.className = 'settings-field-hint' + (field.locked ? ' settings-field-locked' : '');
        hint.textContent = hints.join(' ');
        wrap.appendChild(hint);
      }

      _settingsEntries.push(entry);
      return wrap;
    }

    function renderSettings(data) {
      var body = byId('settings-body');
      body.replaceChildren();
      _settingsEntries = [];
      var groups = data && Array.isArray(data.groups) ? data.groups : [];
      if (!groups.length) {
        var empty = document.createElement('p');
        empty.className = 'settings-state';
        empty.textContent = '没有可编辑的配置项。';
        body.appendChild(empty);
        return;
      }
      groups.forEach(function (group) {
        var section = document.createElement('section');
        section.className = 'settings-group';
        var head = document.createElement('div');
        head.className = 'settings-group-head';
        var title = document.createElement('h3');
        title.textContent = String(group.title || '');
        head.appendChild(title);
        if (group.key === 'refiner' || group.key === 'transcription') {
          var testBtn = document.createElement('button');
          testBtn.type = 'button';
          testBtn.className = 'ghost-btn settings-test-btn';
          testBtn.textContent = '测试连接';
          testBtn.addEventListener('click', function () { testSettings(group.key, testBtn); });
          head.appendChild(testBtn);
        }
        section.appendChild(head);
        if (group.description) {
          var desc = document.createElement('p');
          desc.className = 'settings-group-desc';
          desc.textContent = String(group.description);
          section.appendChild(desc);
        }
        (group.fields || []).forEach(function (field) { section.appendChild(buildSettingsField(field)); });
        body.appendChild(section);
      });
      var writable = !(data && data.writable === false);
      byId('settings-save-btn').disabled = !writable;
      byId('settings-note').textContent = writable
        ? '密钥只写入这台机器上的 config/secrets.env，页面不会回显内容。「测试连接」使用已保存的配置。'
        : '配置目录不可写，无法保存。请检查 config 目录权限或 Docker 挂载。';
    }

    function collectSettingsPayload() {
      var payload = { values: {}, secrets: {} };
      _settingsEntries.forEach(function (entry) {
        if (entry.locked) return;
        if (entry.type === 'secret') {
          var envName = entry.key.replace(/^secret\./, '');
          if (entry.cleared) payload.secrets[envName] = '';
          else if (entry.input.value) payload.secrets[envName] = entry.input.value;
          return;
        }
        if (entry.input.value === entry.initial) return;
        payload.values[entry.key] = entry.input.value;
      });
      return payload;
    }

    function saveSettings() {
      if (_settingsBusy) return;
      var saveBtn = byId('settings-save-btn');
      _settingsBusy = true;
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中…';
      fetch(appUrl('/api/read-podcast/settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectSettingsPayload())
      })
        .then(readJsonResponse)
        .then(function (data) {
          renderSettings(data);
          addLog('配置已保存，立即生效。', 'success');
          refreshAssistantAvailability();
        })
        .catch(function (error) { addLog('保存失败：' + errorMessage(error), 'error'); })
        .then(function () {
          _settingsBusy = false;
          saveBtn.textContent = '保存配置';
          saveBtn.disabled = false;
        });
    }

    function testSettings(target, button) {
      var original = button.textContent;
      button.disabled = true;
      button.textContent = '测试中…';
      fetch(appUrl('/api/read-podcast/settings/test'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: target })
      })
        .then(readJsonResponse)
        .then(function (data) { addLog((data && data.detail) || '连接正常。', 'success'); })
        .catch(function (error) { addLog('测试失败：' + errorMessage(error), 'error'); })
        .then(function () { button.disabled = false; button.textContent = original; });
    }

    function initSettings() {
      byId('settings-btn').addEventListener('click', openSettings);
      byId('settings-close-btn').addEventListener('click', closeSettings);
      byId('settings-overlay').addEventListener('click', closeSettings);
      byId('settings-reload-btn').addEventListener('click', loadSettings);
      byId('settings-save-btn').addEventListener('click', saveSettings);
    }

    initAssistant();
    initConnectors();
    initIntegrations();
    initSettings();
    loadSubscriptions();
    loadHistory();
    loadReadEpisodes();
