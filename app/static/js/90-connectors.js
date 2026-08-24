    // ── 文件连接器（把成稿发送到外部文档/群机器人） ──
    var _connectors = [];
    var _integrationStatuses = [];
    var _activeIntegration = '';
    var _integrationPopup = null;

    function documentConnector(format) {
      return _connectors.find(function (connector) { return connector && connector.format === format; }) || null;
    }

    function providerForFormat(format) { return format === 'gdrive' ? 'google' : 'feishu'; }

    function integrationStatus(provider) {
      return _integrationStatuses.find(function (item) { return item && item.provider === provider; }) || null;
    }

    function renderDocumentLogins() {
      document.querySelectorAll('.document-login').forEach(function (button) {
        var provider = providerForFormat(button.dataset.format);
        var status = integrationStatus(provider);
        var connected = !!(status && status.connected);
        button.classList.toggle('is-connected', connected);
        button.querySelector('.document-state').textContent = connected ? '已连接' : '登录';
        button.setAttribute('aria-label', button.querySelector('.document-name').textContent + (connected ? '，账号已连接' : '，登录'));
      });
    }

    function loadIntegrationStatuses() {
      return fetch(appUrl('/api/read-podcast/integrations'))
        .then(readJsonResponse)
        .then(function (data) {
          _integrationStatuses = Array.isArray(data) ? data : [];
          renderDocumentLogins();
          if (_activeIntegration) renderIntegrationDrawer();
          return _integrationStatuses;
        })
        .catch(function () { _integrationStatuses = []; renderDocumentLogins(); return []; });
    }

    function renderIntegrationDrawer() {
      var provider = _activeIntegration;
      var status = integrationStatus(provider) || { provider: provider, label: provider === 'google' ? 'Google 文档' : '飞书文档', app_configured: false, connected: false };
      var google = provider === 'google';
      byId('integration-title').textContent = '连接' + status.label;
      byId('integration-provider-name').textContent = status.label;
      var mark = byId('integration-provider-mark');
      mark.textContent = google ? 'G' : 'F';
      mark.className = 'document-mark ' + (google ? 'google-mark' : 'feishu-mark');
      var badge = byId('integration-status-badge');
      badge.textContent = status.connected ? '已连接' : '未连接';
      badge.classList.toggle('is-set', !!status.connected);
      byId('integration-client-id-label').textContent = google ? 'OAuth Client ID' : 'App ID';
      byId('integration-client-secret-label').textContent = google ? 'OAuth Client Secret' : 'App Secret';
      setHidden(byId('integration-app-form'), !!status.app_configured);
      setHidden(byId('integration-account-actions'), !status.app_configured);
      setHidden(byId('integration-test-btn'), !status.connected);
      byId('integration-login-btn').textContent = status.connected ? '重新登录' : '使用' + (google ? ' Google' : '飞书') + '账号登录';
    }

    function openIntegration(provider) {
      _activeIntegration = provider;
      _savedScrollY = window.scrollY;
      document.body.style.position = 'fixed';
      document.body.style.top = '-' + _savedScrollY + 'px';
      document.body.style.width = '100%';
      byId('integration-drawer').classList.add('is-open');
      byId('integration-overlay').classList.add('is-open');
      byId('integration-drawer').setAttribute('aria-hidden', 'false');
      document.body.classList.add('overlay-open');
      byId('integration-state').textContent = '';
      byId('integration-client-id').value = '';
      byId('integration-client-secret').value = '';
      renderIntegrationDrawer();
      loadIntegrationStatuses();
      setTimeout(function () { byId('integration-close-btn').focus(); }, 180);
    }

    function closeIntegration() {
      byId('integration-drawer').classList.remove('is-open');
      byId('integration-overlay').classList.remove('is-open');
      byId('integration-drawer').setAttribute('aria-hidden', 'true');
      document.body.classList.remove('overlay-open');
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, _savedScrollY);
      var format = _activeIntegration === 'google' ? 'gdrive' : 'feishu-doc';
      var button = document.querySelector('.document-login[data-format="' + format + '"]');
      _activeIntegration = '';
      if (button) button.focus();
    }

    function oauthRedirectUri(provider) {
      return window.location.origin + APP_BASE_PATH + '/api/read-podcast/integrations/' + provider + '/callback';
    }

    function startIntegrationLogin() {
      var provider = _activeIntegration;
      var loginButton = byId('integration-login-btn');
      loginButton.disabled = true;
      byId('integration-state').textContent = '正在打开登录…';
      _integrationPopup = window.open('', 'read-podcast-oauth', 'popup=yes,width=560,height=720');
      fetch(appUrl('/api/read-podcast/integrations/' + provider + '/authorize'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uri: oauthRedirectUri(provider) })
      })
        .then(readJsonResponse)
        .then(function (data) {
          if (!_integrationPopup) throw new Error('浏览器拦截了登录窗口');
          _integrationPopup.location.href = data.authorization_url;
          byId('integration-state').textContent = '请在登录窗口完成授权';
        })
        .catch(function (error) {
          if (_integrationPopup) _integrationPopup.close();
          byId('integration-state').textContent = errorMessage(error);
        })
        .then(function () { loginButton.disabled = false; });
    }

    function saveIntegrationApp(event) {
      event.preventDefault();
      var provider = _activeIntegration;
      var button = byId('integration-save-login-btn');
      button.disabled = true;
      button.textContent = '保存中…';
      fetch(appUrl('/api/read-podcast/integrations/' + provider + '/app'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: byId('integration-client-id').value, client_secret: byId('integration-client-secret').value })
      })
        .then(readJsonResponse)
        .then(function (status) {
          _integrationStatuses = _integrationStatuses.filter(function (item) { return item.provider !== provider; });
          _integrationStatuses.push(status);
          renderIntegrationDrawer();
          startIntegrationLogin();
        })
        .catch(function (error) { byId('integration-state').textContent = errorMessage(error); })
        .then(function () { button.disabled = false; button.textContent = '保存并登录'; });
    }

    function testActiveIntegration() {
      var connector = documentConnector(_activeIntegration === 'google' ? 'gdrive' : 'feishu-doc');
      if (connector) testConnector(connector);
    }

    function handleIntegrationMessage(event) {
      if (event.origin !== window.location.origin || !event.data || event.data.type !== 'read-podcast-oauth') return;
      if (_integrationPopup) _integrationPopup.close();
      byId('integration-state').textContent = event.data.detail || (event.data.ok ? '账号已连接' : '账号连接失败');
      loadIntegrationStatuses();
      loadConnectors();
    }

    function initIntegrations() {
      loadIntegrationStatuses();
      document.querySelectorAll('.document-login').forEach(function (button) {
        button.addEventListener('click', function () { openIntegration(providerForFormat(button.dataset.format)); });
      });
      byId('integration-close-btn').addEventListener('click', closeIntegration);
      byId('integration-overlay').addEventListener('click', closeIntegration);
      byId('integration-app-form').addEventListener('submit', saveIntegrationApp);
      byId('integration-login-btn').addEventListener('click', startIntegrationLogin);
      byId('integration-test-btn').addEventListener('click', testActiveIntegration);
      window.addEventListener('message', handleIntegrationMessage);
    }

    function closeExportMenu() {
      var menu = byId('export-menu');
      if (menu) menu.hidden = true;
      var btn = byId('reader-export-btn');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    function renderExportMenu() {
      var menu = byId('export-menu');
      menu.replaceChildren();
      if (!_connectors.length) {
        var none = document.createElement('div');
        none.className = 'export-menu-empty';
        none.textContent = '未配置连接器';
        menu.appendChild(none);
        return;
      }
      _connectors.forEach(function (connector) {
        var isDoc = connector.kind === 'doc';
        var item = document.createElement('div');
        item.className = 'export-item' + (connector.configured ? '' : ' is-disabled');

        var head = document.createElement('div');
        head.className = 'export-item-head';
        var nameEl = document.createElement('span');
        nameEl.className = 'export-item-name';
        nameEl.textContent = String(connector.name || '');
        var badge = document.createElement('span');
        badge.className = 'export-item-badge';
        badge.textContent = isDoc ? '📄 云文档' : '🤖 群消息';
        head.append(nameEl, badge);
        item.appendChild(head);

        if (!connector.configured) {
          var hint = document.createElement('div');
          hint.className = 'export-item-hint';
          hint.textContent = '未配置（在 .env 填凭据）';
          item.appendChild(hint);
        } else {
          var actions = document.createElement('div');
          actions.className = 'export-item-actions';
          var full = document.createElement('button');
          full.type = 'button'; full.className = 'export-action';
          full.textContent = '整篇';
          full.addEventListener('click', function () { exportToConnector(connector, 'manuscript'); });
          var summary = document.createElement('button');
          summary.type = 'button'; summary.className = 'export-action';
          summary.textContent = '知识摘要';
          summary.title = '用 AI 提炼核心观点/案例/知识点后再发送';
          summary.addEventListener('click', function () { exportToConnector(connector, 'summary'); });
          var test = document.createElement('button');
          test.type = 'button'; test.className = 'export-action ghost';
          test.textContent = '测试';
          test.addEventListener('click', function () { testConnector(connector); });
          actions.append(full, summary, test);
          item.appendChild(actions);
        }
        menu.appendChild(item);
      });
    }

    function openExportMenu() {
      renderExportMenu();
      var btn = byId('reader-export-btn');
      var menu = byId('export-menu');
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      var rect = btn.getBoundingClientRect();
      var top = rect.bottom + 6;
      var left = Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8));
      menu.style.top = top + 'px';
      menu.style.left = left + 'px';
    }

    function toggleExportMenu() {
      if (byId('export-menu').hidden) openExportMenu();
      else closeExportMenu();
    }

    function exportToConnector(connector, mode) {
      var name = connector && connector.name ? connector.name : String(connector || '');
      if (!_currentReadingTaskId) { addLog('请先打开一篇稿件', 'error'); return; }
      closeExportMenu();
      var modeLabel = mode === 'summary' ? '知识摘要' : '整篇';
      addLog('正在发送' + modeLabel + '到「' + name + '」…', 'running');
      fetch(safeTaskUrl(_currentReadingTaskId, '/export'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connector: name, mode: mode || 'manuscript' })
      })
        .then(function (response) {
          return response.text().then(function (raw) {
            if (!response.ok) { var detail = raw; try { detail = JSON.parse(raw).detail || detail; } catch (ignore) {} throw new Error(detail || 'HTTP ' + response.status); }
            return JSON.parse(raw);
          });
        })
        .then(function (data) {
          var extra = '';
          if (data && data.document_url) extra = ' · 已创建文档';
          else if (data && data.document_id) extra = ' · 文档已创建';
          if (data && data.truncated) extra += '（内容较长已截断）';
          addLog('已发送' + modeLabel + '到「' + name + '」' + extra, 'success');
          if (data && data.document_url) addLog('文档链接：' + data.document_url, 'info');
        })
        .catch(function (error) { addLog('发送失败：' + errorMessage(error), 'error'); });
    }

    function testConnector(connector) {
      var name = connector && connector.name ? connector.name : String(connector || '');
      closeExportMenu();
      addLog('正在测试「' + name + '」…', 'running');
      fetch(appUrl('/api/read-podcast/connectors/' + encodeURIComponent(name) + '/test'), { method: 'POST' })
        .then(function (response) {
          return response.text().then(function (raw) {
            if (!response.ok) { var detail = raw; try { detail = JSON.parse(raw).detail || detail; } catch (ignore) {} throw new Error(detail || 'HTTP ' + response.status); }
            return JSON.parse(raw);
          });
        })
        .then(function (data) { addLog('「' + name + '」' + (data && data.detail ? data.detail : '连接正常'), 'success'); })
        .catch(function (error) { addLog('测试失败：' + errorMessage(error), 'error'); });
    }

    function loadConnectors() {
      return fetch(appUrl('/api/read-podcast/connectors'))
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (data) {
          _connectors = Array.isArray(data) ? data : [];
          // 至少配置好一个连接器时才显示导出入口。
          var anyConfigured = _connectors.some(function (c) { return c.configured; });
          setHidden(byId('reader-export-btn'), !anyConfigured);
          return _connectors;
        })
        .catch(function () { _connectors = []; return []; });
    }

    function initConnectors() {
      loadConnectors();
      byId('reader-export-btn').addEventListener('click', function (event) { event.stopPropagation(); toggleExportMenu(); });
      document.addEventListener('mousedown', function (event) {
        var menu = byId('export-menu');
        if (menu.hidden) return;
        if (!menu.contains(event.target) && event.target !== byId('reader-export-btn')) closeExportMenu();
      });
      window.addEventListener('resize', closeExportMenu);
    }

