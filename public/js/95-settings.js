    // ── 个人配置面板（服务商地址、模型、密钥与文件位置）────────
    var _settingsEntries = [];
    var _settingsBusy = false;

    // ── 外观（应用主题：浅色 / 深色 / 自动）────────────────
    var _appearanceMedia = null;

    function applyAppTheme(theme) {
      var dark = theme === 'dark' || (theme !== 'light' && !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
      document.documentElement.dataset.appTheme = dark ? 'dark' : 'light';
      var meta = document.querySelector('meta[name="color-scheme"]');
      if (meta) meta.setAttribute('content', dark ? 'dark' : 'light');
    }

    function watchSystemTheme() {
      if (!window.matchMedia || _appearanceMedia) return;
      _appearanceMedia = window.matchMedia('(prefers-color-scheme: dark)');
      var handler = function () {
        if (_cloudPrefs.app_theme !== 'auto') return;
        applyAppTheme('auto');
      };
      if (_appearanceMedia.addEventListener) _appearanceMedia.addEventListener('change', handler);
      else if (_appearanceMedia.addListener) _appearanceMedia.addListener(handler);
    }

    function buildAppearanceGroup() {
      var section = document.createElement('section');
      section.className = 'settings-group';
      var head = document.createElement('div');
      head.className = 'settings-group-head';
      var title = document.createElement('h3');
      title.textContent = '外观';
      head.appendChild(title);
      section.appendChild(head);
      var desc = document.createElement('p');
      desc.className = 'settings-group-desc';
      desc.textContent = '选择界面外观；「自动」跟随系统深浅色。';
      section.appendChild(desc);

      var segmented = document.createElement('div');
      segmented.className = 'appearance-segmented';
      segmented.setAttribute('role', 'group');
      segmented.setAttribute('aria-label', '应用外观');
      var stored = _cloudPrefs.app_theme || 'auto';
      [
        { value: 'light', label: '浅色', icon: 'sun' },
        { value: 'dark', label: '深色', icon: 'moon' },
        { value: 'auto', label: '自动', icon: 'auto' }
      ].forEach(function (option) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'appearance-btn' + (stored === option.value ? ' active' : '');
        btn.dataset.themeValue = option.value;
        btn.setAttribute('aria-pressed', stored === option.value ? 'true' : 'false');
        btn.innerHTML = uiIcon(option.icon);
        btn.appendChild(document.createTextNode(option.label));
        btn.addEventListener('click', function () { selectAppTheme(option.value, segmented); });
        segmented.appendChild(btn);
      });
      section.appendChild(segmented);
      return section;
    }

    function selectAppTheme(value, segmented) {
      applyAppTheme(value);
      if (segmented) {
        segmented.querySelectorAll('.appearance-btn').forEach(function (btn) {
          var active = btn.dataset.themeValue === value;
          btn.classList.toggle('active', active);
          btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
      }
      savePreference('app_theme', value);
    }

    function openSettings() {
      if (!requireControl('settings')) return;
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
      fetch(appUrl('/api/control/settings'))
        .then(readApiResponse)
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

      var entry = { key: String(field.key || ''), type: field.type, locked: !!field.locked || isSecret };

      if (isSecret) {
        // 不可编辑项不展示输入框。
        var hintP = document.createElement('p');
        hintP.className = 'settings-field-hint settings-field-locked';
        hintP.textContent = String(field.hint || '此项不能在这里修改');
        wrap.appendChild(hintP);
        _settingsEntries.push(entry);
        return wrap;
      }

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
        control.type = 'text';
        control.autocomplete = 'off';
        control.spellcheck = false;
        control.placeholder = String(field.placeholder || '');
        control.value = String(field.value == null ? '' : field.value);
      }
      control.className = 'form-input';
      control.id = inputId;
      if (field.locked) control.disabled = true;
      entry.input = control;
      entry.initial = control.value;

      wrap.appendChild(control);

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
      body.appendChild(buildAppearanceGroup());
      var groups = data && Array.isArray(data.groups) ? data.groups : [];
      if (!groups.length) {
        var empty = document.createElement('p');
        empty.className = 'settings-state';
        empty.textContent = '没有可编辑的配置项。';
        body.appendChild(empty);
        return;
      }
      var refiner = groups.find(function (group) { return group.key === 'refiner'; });
      var quality = groups.find(function (group) { return group.key === 'quality'; });
      if (refiner) {
        var section = document.createElement('section'); section.className = 'settings-group';
        var head = document.createElement('div'); head.className = 'settings-group-head';
        var title = document.createElement('h3'); title.textContent = '文字整理'; head.appendChild(title);
        var testBtn = document.createElement('button'); testBtn.type = 'button'; testBtn.className = 'ghost-btn settings-test-btn'; testBtn.textContent = '测试'; testBtn.addEventListener('click', function () { testSettings('refiner', testBtn); }); head.appendChild(testBtn);
        section.appendChild(head);
        var fields = refiner.fields || [];
        fields.filter(function (field) { return field.key === 'refiner.model'; }).forEach(function (field) { section.appendChild(buildSettingsField(field)); });
        body.appendChild(section);
        var advanced = document.createElement('details'); advanced.className = 'settings-group settings-advanced';
        var summary = document.createElement('summary'); summary.textContent = '高级设置'; advanced.appendChild(summary);
        fields.filter(function (field) { return field.key !== 'refiner.model'; }).forEach(function (field) { advanced.appendChild(buildSettingsField(field)); });
        if (quality) {
          (quality.fields || []).forEach(function (field) { advanced.appendChild(buildSettingsField(field)); });
          var hint = document.createElement('p'); hint.className = 'settings-group-desc'; hint.textContent = '成稿明显过短时不会发布。'; advanced.appendChild(hint);
        }
        body.appendChild(advanced);
      }
      var writable = !(data && data.writable === false);
      byId('settings-save-btn').disabled = !writable;
      byId('settings-note').textContent = '';
    }

    function collectSettingsPayload() {
      var payload = { values: {} };
      _settingsEntries.forEach(function (entry) {
        if (entry.locked || entry.type === 'secret' || !entry.input) return;
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
      fetch(appUrl('/api/control/settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectSettingsPayload())
      })
        .then(readApiResponse)
        .then(function (data) {
          renderSettings(data);
          addLog('设置已保存。', 'success');
        })
        .catch(function (error) { addLog('保存失败：' + errorMessage(error), 'error'); })
        .then(function () {
          _settingsBusy = false;
          saveBtn.textContent = '保存';
          saveBtn.disabled = false;
        });
    }

    function testSettings(target, button) {
      var original = button.textContent;
      button.disabled = true;
      button.textContent = '测试中…';
      fetch(appUrl('/api/control/settings/test'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: target })
      })
        .then(readApiResponse)
        .then(function (data) { addLog((data && data.detail) || '连接正常。', 'success'); })
        .catch(function (error) { addLog('测试失败：' + errorMessage(error), 'error'); })
        .then(function () { button.disabled = false; button.textContent = original; });
    }

    function initSettings() {
      byId('settings-btn').addEventListener('click', openSettings);
      byId('settings-close-btn').addEventListener('click', closeSettings);
      byId('settings-overlay').addEventListener('click', closeSettings);
      byId('settings-reload-btn').addEventListener('click', closeSettings);
      byId('settings-save-btn').addEventListener('click', saveSettings);
    }

    // 公开浏览的外观选择：显式选择自动 / 浅色 / 深色，仅存本机。
    function renderPublicThemeChooser() {
      var stored = _cloudPrefs.app_theme || 'auto';
      document.querySelectorAll('[data-public-theme]').forEach(function (button) {
        var active = button.dataset.publicTheme === stored;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      var summary = byId('public-theme-btn');
      if (summary) {
        var labels = { auto: '自动', light: '浅色', dark: '深色' };
        summary.title = '外观：' + (labels[stored] || '自动');
        summary.setAttribute('aria-label', '选择外观，当前' + (labels[stored] || '自动'));
      }
    }

    function selectPublicTheme(value) {
      if (value !== 'auto' && value !== 'light' && value !== 'dark') return;
      applyAppTheme(value);
      savePreference('app_theme', value);
      renderPublicThemeChooser();
      var menu = byId('public-theme-menu');
      if (menu) menu.removeAttribute('open');
    }

    function initPublicBrowse() {
      byId('manage-link').href = appUrl('/manage');
      document.querySelectorAll('[data-public-theme]').forEach(function (button) {
        button.addEventListener('click', function () { selectPublicTheme(button.dataset.publicTheme || 'auto'); });
      });
      renderPublicThemeChooser();
    }

    // 公开浏览里点击受保护操作会带着 intent 进入 /manage（见 requireControl）；
    // Access 认证后在这里回到对应位置，并清掉查询串，刷新页面不会重复触发。
    function applyControlIntent(subscriptionsReady) {
      var params = new URLSearchParams(window.location.search);
      var intent = params.get('intent');
      if (!intent) return;
      var podcast = params.get('podcast');
      if (window.history && window.history.replaceState) window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      if (intent === 'settings') openSettings();
      else if (intent === 'subscribe') openDrawer();
      else if (intent === 'import') switchMode('custom');
      else if (podcast) {
        Promise.resolve(subscriptionsReady).then(function () {
          if (_subscriptions.some(function (item) { return item && item.name === podcast; })) selectPodcast(podcast);
        });
      }
    }

    watchSystemTheme();
    initSettings();
    loadCloudPreferences();
    // 订阅、单集快照与稿件在两种模式下都可浏览（browseApi 决定走 public 还是 control）。
    var subscriptionsReady = loadSubscriptions();
    if (IS_MANAGE) {
      // 控制模式：/manage 由 Cloudflare Access 保护；任务队列与已读状态只在这里加载。
      loadHistory();
      loadReadEpisodes();
      applyControlIntent(subscriptionsReady);
    } else {
      // 公开浏览：不读取任务、已读、设置等任何控制面状态。
      initPublicBrowse();
    }
