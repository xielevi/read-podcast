    function switchMode(mode) {
      currentMode = mode;
      var podcastMode = mode === 'podcast';
      var customMode = mode === 'custom';
      var libraryMode = mode === 'library';
      byId('podcast-panel').classList.toggle('is-active', podcastMode);
      byId('custom-panel').classList.toggle('is-active', customMode);
      byId('library-panel').classList.toggle('is-active', libraryMode);
      byId('tab-podcast').classList.toggle('active', podcastMode);
      byId('tab-custom').classList.toggle('active', customMode);
      byId('tab-library').classList.toggle('active', libraryMode);
      byId('tab-podcast').setAttribute('aria-selected', String(podcastMode));
      byId('tab-custom').setAttribute('aria-selected', String(customMode));
      byId('tab-library').setAttribute('aria-selected', String(libraryMode));
      if (customMode) {
        setHidden(byId('episode-inspector'), false);
        byId('inspector-title').textContent = '本地音频';
        byId('inspector-meta').textContent = '选择音频后开始转录';
        byId('inspector-summary').textContent = '从声音到可以慢慢阅读的文字，只需要一次转录。';
      } else if (libraryMode) {
        setHidden(byId('episode-inspector'), false);
        byId('inspector-title').textContent = '稿件库';
        byId('inspector-meta').textContent = '所有已经生成的稿件';
        byId('inspector-summary').textContent = '可以按标题搜索，并直接阅读或下载。';
        loadLibrary();
      } else if (selectedEpisode) {
        renderEpisodeInspector(selectedEpisode);
      } else {
        resetEpisodeInspector();
      }
      if (customMode && _promptTemplates.length === 0) loadPromptTemplates();
    }

    function loadPromptTemplates() {
      fetch(appUrl('/api/read-podcast/prompt-templates'))
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
        .then(function (templates) {
          _promptTemplates = Array.isArray(templates) ? templates : [];
          var select = byId('prompt-template-select');
          while (select.options.length > 1) select.remove(1);
          _promptTemplates.forEach(function (template) {
            var option = document.createElement('option');
            option.value = String(template.content || '');
            option.textContent = String(template.name || '未命名模板');
            select.appendChild(option);
          });
        })
        .catch(function () { addLog('Prompt 模板加载失败', 'warning'); });
    }

    function applyPromptTemplate(content) {
      if (!content) return;
      byId('custom-prompt').value = content;
    }

    function handleAudioDrop(event) {
      event.preventDefault();
      byId('upload-drop-zone').classList.remove('is-dragging');
      if (event.dataTransfer.files.length > 0) doUploadAudio(event.dataTransfer.files[0]);
    }

    function handleAudioFileChange(input) {
      if (input.files.length > 0) doUploadAudio(input.files[0]);
    }

    function doUploadAudio(file) {
      _uploadedAudioPath = null;
      setHidden(byId('upload-progress-wrap'), false);
      setHidden(byId('upload-success-info'), true);
      setHidden(byId('upload-hint'), true);
      byId('upload-status').textContent = '上传中……';
      byId('upload-progress-inner').style.width = '0%';
      var formData = new FormData();
      formData.append('file', file);
      var xhr = new XMLHttpRequest();
      xhr.open('POST', appUrl('/api/read-podcast/upload/audio'));
      xhr.upload.onprogress = function (event) {
        if (!event.lengthComputable) return;
        var percent = Math.round(event.loaded / event.total * 100);
        byId('upload-progress-inner').style.width = percent + '%';
        byId('upload-status').textContent = '上传中…… ' + percent + '%';
      };
      xhr.onload = function () {
        if (xhr.status === 200) {
          try {
            var result = JSON.parse(xhr.responseText);
            _uploadedAudioPath = result.server_path;
            byId('upload-status').textContent = '上传完成';
            byId('upload-progress-inner').style.width = '100%';
            setHidden(byId('upload-success-info'), false);
            byId('upload-success-info').textContent = '✓ ' + String(result.original_name || file.name) + ' (' + Math.round(Number(result.size || file.size) / 1024 / 1024 * 10) / 10 + ' MB)';
            addLog('文件上传成功：' + String(result.filename || file.name), 'success');
          } catch (error) { addLog('上传响应无法解析', 'error'); }
        } else {
          var message = '上传失败';
          try { message = JSON.parse(xhr.responseText).detail || message; } catch (ignore) {}
          byId('upload-status').textContent = message;
          setHidden(byId('upload-hint'), false);
          addLog('文件上传失败：' + message, 'error');
        }
      };
      xhr.onerror = function () { byId('upload-status').textContent = '网络错误，上传失败'; setHidden(byId('upload-hint'), false); addLog('文件上传网络错误', 'error'); };
      xhr.send(formData);
    }

    function doDeleteSubscription(name) {
      if (!name) return;
      fetch(appUrl('/api/read-podcast/subscriptions/' + encodeURIComponent(name)), { method: 'DELETE' })
        .then(function (res) { return res.json().then(function (data) { if (!res.ok) throw new Error(data.detail || 'HTTP ' + res.status); return data; }); })
        .then(function () {
          addLog('已取消订阅节目「' + name + '」', 'info');
          if (selectedPodcast === name) {
            selectedPodcast = null;
            allEpisodes = [];
            currentPage = 1;
            resetEpisodeInspector();
            byId('center-title').textContent = '全部订阅';
            byId('center-sub').textContent = '按时间线展示所有订阅';
            byId('episode-list').replaceChildren();
            setHidden(byId('episode-list'), true);
            setHidden(byId('episode-pagination'), true);
            setHidden(byId('episode-empty'), false);
          }
          loadSubscriptions();
        })
        .catch(function (err) { addLog('删除订阅失败：' + errorMessage(err), 'error'); });
    }

    function createPodcastItem(podcast, index) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'podcast-item';
      item.dataset.name = String(podcast.name || '');
      item.style.setProperty('--item-index', index);
      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.setAttribute('aria-hidden', 'true');
      item._statusDot = dot;
      var copy = document.createElement('span');
      copy.style.minWidth = '0';
      var name = document.createElement('span');
      name.className = 'pod-name';
      name.style.display = 'block';
      name.textContent = String(podcast.name || '未命名节目');
      var meta = document.createElement('span');
      meta.className = 'pod-meta';
      meta.style.display = 'block';
      try { meta.textContent = podcast.rss_url ? new URL(podcast.rss_url).hostname : 'RSS feed'; }
      catch (error) { meta.textContent = 'RSS feed'; }
      copy.append(name, meta);

      var deleteBtn = document.createElement('span');
      deleteBtn.className = 'pod-delete-btn';
      deleteBtn.title = '取消订阅';
      deleteBtn.textContent = '✕';
      deleteBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (deleteBtn.dataset.confirming === 'true') {
          doDeleteSubscription(String(podcast.name || ''));
          return;
        }
        deleteBtn.dataset.confirming = 'true';
        deleteBtn.textContent = '再按一次';
        deleteBtn.setAttribute('aria-label', '再次点击确认取消订阅');
        setTimeout(function () { deleteBtn.dataset.confirming = 'false'; deleteBtn.textContent = '✕'; deleteBtn.removeAttribute('aria-label'); }, 3000);
      });

      item.append(dot, copy, deleteBtn);
      item.addEventListener('click', function () { selectPodcast(String(podcast.name || '')); });
      return item;
    }

    function createAllPodcastsItem() {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'podcast-item all-podcasts-item';
      item.dataset.name = '';
      item.style.setProperty('--item-index', 0);
      var dot = document.createElement('span');
      dot.className = 'dot dot-accent';
      dot.setAttribute('aria-hidden', 'true');
      var copy = document.createElement('span');
      copy.style.minWidth = '0';
      var name = document.createElement('span');
      name.className = 'pod-name';
      name.style.display = 'block';
      name.textContent = '全部订阅';
      var meta = document.createElement('span');
      meta.className = 'pod-meta';
      meta.style.display = 'block';
      meta.textContent = '按时间线浏览';
      copy.append(name, meta);
      item.append(dot, copy);
      item.addEventListener('click', selectAllPodcasts);
      return item;
    }

    function selectAllPodcasts() {
      if (currentMode !== 'podcast') switchMode('podcast');
      selectedPodcast = null;
      currentPage = 1;
      resetEpisodeInspector();
      document.querySelectorAll('.podcast-item').forEach(function (item) { item.classList.toggle('active', !item.dataset.name); });
      loadTimelineEpisodes(_subscriptions, false);
    }

    function renderPodcastList(podcasts) {
      var list = byId('podcast-list');
      list.replaceChildren();
      var allItem = createAllPodcastsItem();
      if (!selectedPodcast) allItem.classList.add('active');
      list.appendChild(allItem);
      if (!Array.isArray(podcasts) || podcasts.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.style.minHeight = '90px';
        empty.textContent = '暂无订阅节目';
        list.appendChild(empty);
        return;
      }
      var fragment = document.createDocumentFragment();
      podcasts.forEach(function (podcast, index) {
        var item = createPodcastItem(podcast, index);
        if (selectedPodcast === podcast.name) item.classList.add('active');
        fragment.appendChild(item);
      });
      list.appendChild(fragment);
    }

    // 封面图统一走服务端代理（SSRF 校验 + 体积/类型限制），避免浏览器直连第三方 CDN。
    function artworkUrl(image) {
      return image ? appUrl('/api/read-podcast/artwork?url=' + encodeURIComponent(image)) : '';
    }

    function makeArtworkTile(image, fallbackText, className) {
      var wrap = document.createElement('span');
      wrap.className = className;
      var mono = document.createElement('span');
      mono.className = 'art-monogram';
      mono.textContent = String(fallbackText || '播').trim().slice(0, 1) || '播';
      wrap.appendChild(mono);
      if (image) {
        var img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        img.decoding = 'async';
        img.addEventListener('load', function () { wrap.classList.add('has-art'); });
        img.addEventListener('error', function () { img.remove(); });
        img.src = artworkUrl(image);
        wrap.appendChild(img);
      }
      return wrap;
    }

    function renderCoverCollage(podcasts) {
      var section = byId('cover-collage');
      var strip = byId('cover-strip');
      if (!section || !strip) return;
      var withArt = (Array.isArray(podcasts) ? podcasts : []).filter(function (p) { return p && p.image; });
      if (withArt.length < 2) { section.hidden = true; strip.replaceChildren(); return; }
      strip.replaceChildren();
      withArt.slice(0, 8).forEach(function (podcast) {
        var tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'cover-tile';
        tile.title = String(podcast.name || '');
        tile.appendChild(makeArtworkTile(podcast.image, podcast.name, 'cover-art'));
        tile.addEventListener('click', function () { selectPodcast(String(podcast.name || '')); });
        strip.appendChild(tile);
      });
      var edition = byId('cover-edition');
      if (edition) {
        edition.textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) + ' · 订阅合集';
      }
      section.hidden = false;
    }

    function loadSubscriptions() {
      return fetch(appUrl('/api/read-podcast/subscriptions'))
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
        .then(function (podcasts) {
          _subscriptions = Array.isArray(podcasts) ? podcasts : [];
          if (selectedPodcast && !_subscriptions.some(function (podcast) { return podcast && podcast.name === selectedPodcast; })) {
            selectedPodcast = null;
          }
          renderPodcastList(_subscriptions);
          renderCoverCollage(_subscriptions);
          loadTimelineEpisodes(getScopedSubscriptions(), false);
          return _subscriptions;
        })
        .catch(function () { byId('server-dot').style.background = 'var(--error)'; byId('server-status').textContent = '暂不可用'; });
    }

    function getScopedSubscriptions() {
      if (!selectedPodcast) return _subscriptions.slice();
      return _subscriptions.filter(function (podcast) { return podcast && String(podcast.name || '') === selectedPodcast; });
    }

    function decorateEpisodes(podcastName, episodes) {
      return (Array.isArray(episodes) ? episodes : []).map(function (episode) {
        return Object.assign({}, episode, { podcast_name: String(episode.podcast_name || podcastName || '') });
      });
    }

    function sortEpisodeTimeline(episodes) {
      return episodes.slice().sort(function (left, right) {
        var leftTime = Date.parse(left.published || '') || 0;
        var rightTime = Date.parse(right.published || '') || 0;
        return rightTime - leftTime;
      });
    }

    function updateTimelineHeading(cacheState) {
      var scopeCount = getScopedSubscriptions().length;
      byId('center-title').textContent = selectedPodcast || '全部订阅';
      var pieces = [];
      if (allEpisodes.length) pieces.push('按时间线');
      if (selectedPodcast) pieces.push(allEpisodes.length + ' 期');
      else if (scopeCount) pieces.push(scopeCount + ' 档节目 · ' + allEpisodes.length + ' 期');
      if (cacheState === 'warming') pieces.push('正在补齐历史单集');
      byId('center-sub').textContent = pieces.join(' · ') || (scopeCount ? '正在读取订阅…' : '先添加一档节目，时间线会从这里开始');
    }

    function loadTimelineEpisodes(podcasts, force) {
      var scope = (Array.isArray(podcasts) ? podcasts : []).filter(function (podcast) { return podcast && podcast.name; });
      var requestToken = ++_timelineRequestToken;
      allEpisodes = [];
      currentPage = 1;
      resetEpisodeInspector();
      byId('episode-search').value = '';
      byId('episode-search').disabled = !scope.length;
      currentFilter = 'all';
      setFilterButtons('all');
      setHidden(byId('refresh-btn'), !scope.length);
      setHidden(byId('episode-empty'), true);
      setHidden(byId('episode-list'), false);
      updateTimelineHeading();
      if (!scope.length) {
        renderEpisodeList([]);
        return Promise.resolve([]);
      }

      renderSkeletons(Math.min(12, Math.max(4, scope.length * 3)));
      var previews = Promise.all(scope.map(function (podcast) {
        return fetchEpisodePage(String(podcast.name), force).catch(function () { return { episodes: [], cacheState: 'error' }; });
      }));
      return previews.then(function (previewResults) {
        if (requestToken !== _timelineRequestToken) return [];
        var previewEpisodes = [];
        var warming = false;
        previewResults.forEach(function (result, index) {
          if (result && result.cacheState === 'warming') warming = true;
          previewEpisodes = previewEpisodes.concat(decorateEpisodes(scope[index].name, result && result.episodes));
        });
        allEpisodes = sortEpisodeTimeline(previewEpisodes);
        updateTimelineHeading(warming ? 'warming' : 'complete');
        renderEpisodeList(getFilteredEpisodes());

        return Promise.all(scope.map(function (podcast) {
          return hydrateAllEpisodes(String(podcast.name)).catch(function () { return null; });
        })).then(function (fullResults) {
          if (requestToken !== _timelineRequestToken) return [];
          var merged = [];
          scope.forEach(function (podcast, index) {
            var full = fullResults[index];
            var source = full && Array.isArray(full.episodes) ? full.episodes : (previewResults[index] && previewResults[index].episodes);
            merged = merged.concat(decorateEpisodes(podcast.name, source));
          });
          allEpisodes = sortEpisodeTimeline(merged);
          updateTimelineHeading('complete');
          renderEpisodeList(getFilteredEpisodes());
          return allEpisodes;
        });
      }).catch(function (error) {
        if (requestToken !== _timelineRequestToken) return [];
        allEpisodes = [];
        renderEpisodeList([]);
        addLog('加载节目时间线失败：' + errorMessage(error), 'error');
        return [];
      });
    }

