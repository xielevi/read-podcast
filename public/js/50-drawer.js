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
      clearTimeout(_drawerSearchTimer);
      _drawerSearchSeq += 1;
      byId('drawer-search').value = '';
      byId('drawer-results').replaceChildren();
    }
    function onDrawerSearch(value) {
      clearTimeout(_drawerSearchTimer);
      var seq = ++_drawerSearchSeq;
      var query = value.trim();
      if (!query) { byId('drawer-results').replaceChildren(); return; }
      byId('drawer-results').textContent = /^https?:\/\//i.test(query) ? t('drawer.identifying') : t('drawer.searching');
      // 200ms debounce：比原来的 420ms 明显更快给出结果，同时保留防抖语义。
      _drawerSearchTimer = setTimeout(function () {
        if (seq !== _drawerSearchSeq) return;
        if (/^https?:\/\//i.test(query)) renderRssCandidate(query);
        else fetchSearchResults(query, seq);
      }, 200);
    }
    function renderRssCandidate(url) {
      var results = byId('drawer-results'); results.replaceChildren();
      var item = document.createElement('div'); item.className = 'search-result rss-candidate';
      var copy = document.createElement('span'); copy.style.minWidth = '0';
      var name = document.createElement('span'); name.className = 'result-name'; name.textContent = t('drawer.rss_feed');
      var meta = document.createElement('span'); meta.className = 'result-meta'; meta.textContent = url;
      copy.append(name, meta);
      var subscribe = document.createElement('button'); subscribe.type = 'button'; subscribe.className = 'solid-btn'; subscribe.textContent = t('drawer.subscribe');
      subscribe.addEventListener('click', function () { confirmAddPodcast('', url, '', subscribe); });
      item.append(copy, subscribe); results.appendChild(item);
    }
    function fetchSearchResults(query, seq) {
      // stale-result 保护：输入变化、切换 RSS 候选或关闭抽屉都会推进序号，
      // 只有当前输入对应的请求允许渲染结果。
      var requestSeq = seq == null ? ++_drawerSearchSeq : seq;
      fetch(browseApi('/search/podcast?q=' + encodeURIComponent(query)))
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
        .then(function (items) { if (requestSeq !== _drawerSearchSeq) return; renderSearchResults(Array.isArray(items) ? items : []); })
        .catch(function () { if (requestSeq !== _drawerSearchSeq) return; renderSearchResults([]); });
    }
    function renderSearchResults(items) {
      var results = byId('drawer-results'); results.replaceChildren();
      if (!items.length) {
        var empty = document.createElement('div'); empty.className = 'empty-state'; empty.style.minHeight = '180px';
        var emptyIcon = document.createElement('span'); emptyIcon.className = 'empty-state-icon'; emptyIcon.innerHTML = uiIcon('search'); empty.appendChild(emptyIcon);
        var message = document.createElement('div'); message.innerHTML = '<strong>' + escapeHtml(t('drawer.no_matches')) + '</strong><br><span>' + escapeHtml(t('drawer.no_matches_hint')) + '</span>';
        empty.appendChild(message); results.appendChild(empty); return;
      }
      items.forEach(function (podcast, index) {
        var item = document.createElement('div'); item.className = 'search-result'; item.style.setProperty('--item-index', index);
        var monogram = makeArtworkTile(artworkUrl(podcast.image), podcast.name, 'result-monogram');
        var copy = document.createElement('span'); copy.style.minWidth = '0';
        var name = document.createElement('span'); name.className = 'result-name'; name.style.display = 'block'; name.textContent = String(podcast.name || t('drawer.untitled_podcast'));
        var meta = document.createElement('span'); meta.className = 'result-meta'; meta.style.display = 'block'; meta.textContent = [podcast.artist, podcast.genre, podcast.track_count ? podcast.track_count + t('drawer.episodes_count') : ''].filter(Boolean).join(' · ');
        copy.append(name, meta);
        var subscribe = document.createElement('button'); subscribe.type = 'button'; subscribe.className = 'solid-btn'; subscribe.textContent = t('drawer.subscribe');
        subscribe.addEventListener('click', function () { confirmAddPodcast(String(podcast.name || ''), String(podcast.rss_url || ''), String(podcast.image || ''), subscribe); });
        item.append(monogram, copy, subscribe); results.appendChild(item);
      });
    }
    function confirmAddPodcast(name, rssUrl, image, sourceButton) {
      var cleanName = String(name || '').trim(); var cleanUrl = String(rssUrl || '').trim();
      if (!cleanUrl) { addLog(t('drawer.invalid_rss'), 'error'); return; }
      if (!requireControl('subscribe')) return;
      if (sourceButton) sourceButton.disabled = true;
      addLog(t('drawer.subscribing'), 'running');
      fetch(appUrl('/api/control/subscriptions'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: cleanName, rss_url: cleanUrl, image: String(image || '') }) })
        .then(readApiResponse)
        .then(function (data) { addLog(t('drawer.subscribed_log', String(data.name || cleanName || t('drawer.new_podcast'))), 'success'); closeDrawer(); loadSubscriptions(); })
        .catch(function (error) { addLog(t('drawer.add_failed') + errorMessage(error), 'error'); })
        .finally(function () { if (sourceButton) sourceButton.disabled = false; });
    }

    var _tocObserver = null;
