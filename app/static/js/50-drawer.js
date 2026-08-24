    function openDrawer() {
      _savedScrollY = window.scrollY;
      document.body.style.position = 'fixed';
      document.body.style.top = '-' + _savedScrollY + 'px';
      document.body.style.width = '100%';
      byId('drawer').classList.add('is-open'); byId('drawer-overlay').classList.add('is-open'); byId('drawer').setAttribute('aria-hidden', 'false'); document.body.classList.add('overlay-open');
      setTimeout(function () { byId('drawer-search').focus(); }, 180);
    }
    function closeDrawer() {
      byId('drawer').classList.remove('is-open'); byId('drawer-overlay').classList.remove('is-open'); byId('drawer').setAttribute('aria-hidden', 'true'); document.body.classList.remove('overlay-open'); clearDrawerState();
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, _savedScrollY);
    }
    function clearDrawerState() {
      byId('drawer-search').value = ''; byId('drawer-results').replaceChildren(); setHidden(byId('drawer-confirm-footer'), true); byId('manual-rss-url').value = ''; byId('manual-pod-name').value = ''; _drawerSelected = null; setDrawerMode('search');
    }
    function setDrawerMode(mode) {
      _drawerMode = mode;
      var manual = mode === 'manual';
      setHidden(byId('drawer-manual'), !manual); setHidden(byId('drawer-results'), manual);
      byId('mode-search-btn').classList.toggle('active', !manual); byId('mode-manual-btn').classList.toggle('active', manual);
      if (manual) {
        setHidden(byId('drawer-confirm-footer'), true);
      } else if (_drawerSelected) {
        setHidden(byId('drawer-confirm-footer'), false);
      }
    }
    function onDrawerSearch(value) {
      clearTimeout(_drawerSearchTimer);
      var query = value.trim();
      if (!query) { byId('drawer-results').replaceChildren(); return; }
      byId('drawer-results').textContent = '搜索中……';
      _drawerSearchTimer = setTimeout(function () { fetchSearchResults(query); }, 500);
    }
    function fetchSearchResults(query) {
      fetch(appUrl('/api/read-podcast/search/podcast?q=' + encodeURIComponent(query)))
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
        .then(function (items) { renderSearchResults(Array.isArray(items) ? items : []); })
        .catch(function () { renderSearchResults([]); });
    }
    function renderSearchResults(items) {
      var results = byId('drawer-results'); results.replaceChildren();
      if (!items.length) {
        var empty = document.createElement('div'); empty.className = 'empty-state'; empty.style.minHeight = '180px';
        var message = document.createElement('div'); message.textContent = '未找到结果，或 iTunes 暂时不可用。';
        var manualButton = document.createElement('button'); manualButton.type = 'button'; manualButton.className = 'ghost-btn'; manualButton.style.marginTop = '12px'; manualButton.textContent = '手动输入 RSS URL'; manualButton.addEventListener('click', function () { setDrawerMode('manual'); });
        message.appendChild(manualButton); empty.appendChild(message); results.appendChild(empty); return;
      }
      items.forEach(function (podcast, index) {
        var item = document.createElement('button'); item.type = 'button'; item.className = 'search-result'; item.style.setProperty('--item-index', index);
        var monogram = makeArtworkTile(podcast.image, podcast.name, 'result-monogram');
        var copy = document.createElement('span'); copy.style.minWidth = '0';
        var name = document.createElement('span'); name.className = 'result-name'; name.style.display = 'block'; name.textContent = String(podcast.name || '未命名播客');
        var meta = document.createElement('span'); meta.className = 'result-meta'; meta.style.display = 'block'; meta.textContent = [podcast.artist, podcast.genre, podcast.track_count ? podcast.track_count + ' 集' : ''].filter(Boolean).join(' · ');
        copy.append(name, meta);
        var arrow = document.createElement('span'); arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true');
        item.append(monogram, copy, arrow); item.addEventListener('click', function () { selectDrawerCandidate(String(podcast.name || ''), String(podcast.rss_url || ''), String(podcast.image || '')); }); results.appendChild(item);
      });
    }
    function selectDrawerCandidate(name, rssUrl, image) { _drawerSelected = { name: name, rss_url: rssUrl, image: image || '' }; byId('drawer-selected-name').textContent = name; byId('drawer-selected-rss').textContent = rssUrl; setHidden(byId('drawer-confirm-footer'), false); }
    function clearDrawerSelection() { _drawerSelected = null; setHidden(byId('drawer-confirm-footer'), true); }
    function confirmSelectedPodcast() { if (_drawerSelected) confirmAddPodcast(_drawerSelected.name, _drawerSelected.rss_url, _drawerSelected.image); }
    function confirmAddPodcast(name, rssUrl, image) {
      var cleanName = String(name || '').trim(); var cleanUrl = String(rssUrl || '').trim();
      if (!cleanName || !cleanUrl) { addLog('错误：节目名称和 RSS URL 均不能为空', 'error'); return; }
      var buttons = [byId('confirm-add-btn'), byId('manual-add-btn')]; buttons.forEach(function (button) { button.disabled = true; });
      addLog('正在验证 RSS：' + cleanName, 'running');
      fetch(appUrl('/api/read-podcast/subscriptions'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: cleanName, rss_url: cleanUrl, image: String(image || '') }) })
        .then(function (response) { return response.json().then(function (data) { if (!response.ok) throw new Error(data.detail || 'HTTP ' + response.status); return data; }); })
        .then(function () { addLog('节目「' + cleanName + '」已成功订阅', 'success'); closeDrawer(); loadSubscriptions(); })
        .catch(function (error) { addLog('添加失败：' + errorMessage(error), 'error'); })
        .finally(function () { buttons.forEach(function (button) { button.disabled = false; }); });
    }

    var _tocObserver = null;

