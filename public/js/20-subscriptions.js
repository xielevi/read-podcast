    function switchMode(mode) {
      currentMode = mode;
      document.body.dataset.mode = mode;
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
      document.querySelectorAll('.mobile-nav [data-mode]').forEach(function (button) {
        button.classList.toggle('active', button.dataset.mode === mode);
      });
      if (libraryMode) {
        loadLibrary();
      } else if (selectedEpisode) {
        renderEpisodeInspector(selectedEpisode);
      } else {
        resetEpisodeInspector();
      }
      // 稿件风格模板属于控制面配置；公开浏览只展示导入界面本身。
      if (customMode && IS_MANAGE && _promptTemplates.length === 0) loadPromptTemplates();
    }

    function loadPromptTemplates() {
      fetch(appUrl('/api/control/prompt-templates'))
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
        .then(function (templates) {
          _promptTemplates = Array.isArray(templates) ? templates : [];
          var select = byId('prompt-template-select');
          while (select.options.length > 1) select.remove(1);
          _promptTemplates.forEach(function (template) {
            var option = document.createElement('option');
            option.value = String(template.content || '');
            option.textContent = String(template.name || t('custom.untitled_template'));
            select.appendChild(option);
          });
          if (_promptTemplates.length > 0) {
            select.selectedIndex = 1;
            applyPromptTemplate(_promptTemplates[0].content);
          }
        })
        .catch(function () { addLog(t('custom.templates_load_failed'), 'warning'); });
    }

    function applyPromptTemplate(content) {
      if (!content) return;
      byId('custom-prompt').value = content;
    }

    function handleAudioDrop(event) {
      event.preventDefault();
      byId('upload-drop-zone').classList.remove('is-dragging');
      if (!requireControl('import')) return;
      if (event.dataTransfer.files.length > 0) doUploadAudio(event.dataTransfer.files[0]);
    }

    function handleAudioFileChange(input) {
      if (input.files.length > 0) doUploadAudio(input.files[0]);
    }

    function doUploadAudio(file) {
      if (!requireControl('import')) return;
      _uploadedAudioPath = null;
      _uploadedAudioTitle = null;

      // 产品硬上限 200 MiB（= 209,715,200 字节）；Cloudflare 才是权威校验方，这里只是让用户立即得到反馈、不进入上传流程。
      var MAX_SIZE = 200 * 1024 * 1024;
      if (file.size > MAX_SIZE) {
        addLog(t('custom.file_size_exceeded'), 'error');
        byId('upload-status').textContent = t('custom.file_size_hint', (Math.round(file.size / 1024 / 1024 * 10) / 10));
        setHidden(byId('upload-progress-wrap'), false);
        setHidden(byId('upload-success-info'), true);
        setHidden(byId('upload-hint'), false);
        byId('upload-progress-inner').style.width = '0%';
        return;
      }

      setHidden(byId('upload-progress-wrap'), false);
      setHidden(byId('upload-success-info'), true);
      setHidden(byId('upload-hint'), true);
      byId('upload-status').textContent = t('custom.upload_ready');
      byId('upload-progress-inner').style.width = '0%';

      var CHUNK_SIZE = 10 * 1024 * 1024; // 10 MiB 分片（200 MiB 上限 → 至多 20 片）
      var totalParts = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
      var uploadId = null;
      var r2UploadId = null;
      var key = null;
      var uploadedParts = [];
      var uploadedBytes = 0;

      // 1. 初始化分片上传
      fetch(appUrl('/api/control/uploads/multipart/start?filename=' + encodeURIComponent(file.name) + '&size=' + file.size), {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' }
      })
        .then(readApiResponse)
        .then(function (initData) {
          uploadId = initData.upload_id;
          r2UploadId = initData.r2_upload_id;
          key = initData.key;

          // 2. 串行顺序上传分片（带重试机制）
          function uploadChunk(partIndex) {
            if (partIndex >= totalParts) {
              // 3. 完成合并
              byId('upload-status').textContent = t('custom.upload_merging');
              return fetch(appUrl('/api/control/uploads/multipart/' + encodeURIComponent(uploadId) + '/complete'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ r2_upload_id: r2UploadId, key: key, parts: uploadedParts })
              }).then(readApiResponse).then(function () {
                _uploadedAudioPath = uploadId;
                _uploadedAudioTitle = file.name.replace(/\.[^/.]+$/, "");
                byId('upload-status').textContent = t('custom.upload_complete');
                byId('upload-progress-inner').style.width = '100%';
                setHidden(byId('upload-success-info'), false);
                byId('upload-success-info').textContent = '✓ ' + file.name + ' (' + Math.round(file.size / 1024 / 1024 * 10) / 10 + ' MiB)';
                addLog(t('custom.upload_success', file.name), 'success');
              });
            }

            var partNumber = partIndex + 1;
            var start = partIndex * CHUNK_SIZE;
            var end = Math.min(file.size, start + CHUNK_SIZE);
            var chunk = file.slice(start, end);
            var chunkSize = end - start;

            function doUploadPart(attempt) {
              return fetch(appUrl('/api/control/uploads/multipart/' + encodeURIComponent(uploadId) + '/parts/' + partNumber), {
                method: 'PUT',
                headers: {
                  'x-r2-upload-id': r2UploadId,
                  'x-upload-key': key,
                  'Content-Type': 'application/octet-stream'
                },
                body: chunk
              }).then(readApiResponse).catch(function (err) {
                if (attempt < 3) {
                  return new Promise(function (resolve) { setTimeout(resolve, 1000); }).then(function () {
                    return doUploadPart(attempt + 1);
                  });
                }
                throw err;
              });
            }

            byId('upload-status').textContent = t('custom.upload_progress', 0);
            return doUploadPart(1).then(function (partResult) {
              uploadedParts.push({ partNumber: partNumber, etag: partResult.etag });
              uploadedBytes += chunkSize;
              var percent = Math.min(99, Math.round((uploadedBytes / file.size) * 100));
              byId('upload-progress-inner').style.width = percent + '%';
              byId('upload-status').textContent = t('custom.upload_progress', percent);
              return uploadChunk(partIndex + 1);
            });
          }

          return uploadChunk(0);
        })
        .catch(function (err) {
          var message = (err && err.message) || t('custom.upload_failed');
          byId('upload-status').textContent = message;
          setHidden(byId('upload-hint'), false);
          addLog(t('custom.upload_failed_msg', message), 'error');
          if (uploadId && r2UploadId && key) {
            fetch(appUrl('/api/control/uploads/multipart/' + encodeURIComponent(uploadId) + '/abort'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ r2_upload_id: r2UploadId, key: key })
            }).catch(function () {});
          }
        });
    }

    function doDeleteSubscription(name) {
      if (!name || !requireControl('unsubscribe')) return;
      fetch(appUrl('/api/control/subscriptions/' + encodeURIComponent(name)), { method: 'DELETE' })
        .then(readApiResponse)
        .then(function () {
          addLog(t('subscription.unsubscribed', name), 'info');
          if (selectedPodcast === name) {
            selectedPodcast = null;
            pageEpisodes = [];
            currentPage = 1;
            resetEpisodeInspector();
            byId('center-title').textContent = t('content.all_subscriptions');
            byId('center-sub').textContent = t('subscription.timeline_desc');
            byId('episode-list').replaceChildren();
            setHidden(byId('episode-list'), true);
            setHidden(byId('episode-pagination'), true);
            setHidden(byId('episode-empty'), false);
          }
          loadSubscriptions();
        })
        .catch(function (err) { addLog(t('subscription.delete_failed') + errorMessage(err), 'error'); });
    }

    function createPodcastItem(podcast, index) {
      var item = document.createElement('div');
      item.className = 'podcast-item';
      item.dataset.name = String(podcast.name || '');
      item.style.setProperty('--item-index', index);

      var selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'pod-select-btn';

      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.setAttribute('aria-hidden', 'true');
      item._statusDot = dot;

      var copy = document.createElement('span');
      copy.style.minWidth = '0';
      var name = document.createElement('span');
      name.className = 'pod-name';
      name.style.display = 'block';
      name.textContent = String(podcast.name || t('subscription.untitled'));
      var meta = document.createElement('span');
      meta.className = 'pod-meta';
      meta.style.display = 'block';
      // 公开浏览只拿到脱敏后的 source_host；控制模式从完整 RSS 地址取域名。
      var host = String(podcast.source_host || '');
      if (!host && podcast.rss_url) { try { host = new URL(podcast.rss_url).hostname; } catch (error) { host = ''; } }
      meta.textContent = host || t('drawer.rss_feed');
      copy.append(name, meta);
      selectBtn.append(dot, copy);
      selectBtn.addEventListener('click', function () { selectPodcast(String(podcast.name || '')); });

      if (!IS_MANAGE) {
        item.appendChild(selectBtn);
        return item;
      }

      var deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'pod-delete-btn';
      deleteBtn.title = t('subscription.unsubscribe');
      deleteBtn.setAttribute('aria-label', t('subscription.unsubscribe_aria', (podcast.name || t('subscription.untitled'))));
      deleteBtn.innerHTML = uiIcon('trash');

      var confirmTimer = null;
      function resetDeleteBtn() {
        if (confirmTimer) {
          clearTimeout(confirmTimer);
          confirmTimer = null;
        }
        deleteBtn.dataset.confirming = 'false';
        deleteBtn.innerHTML = uiIcon('trash');
        deleteBtn.setAttribute('aria-label', t('subscription.unsubscribe_aria', (podcast.name || t('subscription.untitled'))));
      }

      deleteBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!requireControl('unsubscribe')) return;
        if (deleteBtn.dataset.confirming === 'true') {
          resetDeleteBtn();
          doDeleteSubscription(String(podcast.name || ''));
          return;
        }
        deleteBtn.dataset.confirming = 'true';
        deleteBtn.textContent = t('subscription.confirm_delete');
        deleteBtn.setAttribute('aria-label', t('subscription.confirm_delete_aria', (podcast.name || t('subscription.untitled'))));
        confirmTimer = setTimeout(resetDeleteBtn, 3000);
      });

      item.append(selectBtn, deleteBtn);
      return item;
    }

    function createAllPodcastsItem() {
      var item = document.createElement('div');
      item.className = 'podcast-item all-podcasts-item';
      item.dataset.name = '';
      item.style.setProperty('--item-index', 0);

      var selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'pod-select-btn';

      var dot = document.createElement('span');
      dot.className = 'dot dot-accent';
      dot.setAttribute('aria-hidden', 'true');
      var copy = document.createElement('span');
      copy.style.minWidth = '0';
      var name = document.createElement('span');
      name.className = 'pod-name';
      name.style.display = 'block';
      name.textContent = t('content.all_subscriptions');
      var meta = document.createElement('span');
      meta.className = 'pod-meta';
      meta.style.display = 'block';
      meta.textContent = t('subscription.timeline_browse');
      copy.append(name, meta);
      selectBtn.append(dot, copy);
      selectBtn.addEventListener('click', selectAllPodcasts);

      item.append(selectBtn);
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
        var emptyIcon = document.createElement('span');
        emptyIcon.className = 'empty-state-icon';
        emptyIcon.innerHTML = uiIcon('rss');
        empty.appendChild(emptyIcon);
        empty.appendChild(document.createTextNode(t('subscription.empty_shows')));
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
      return image ? browseApi('/artwork?url=' + encodeURIComponent(image)) : '';
    }

    // 订阅封面：控制模式按原始地址代理；公开浏览拿不到原始地址（可能带凭据），按节目名由服务端代理。
    function subscriptionArtworkUrl(podcast) {
      if (!podcast) return '';
      if (IS_MANAGE) return artworkUrl(podcast.image);
      return podcast.has_artwork ? browseApi('/artwork?podcast=' + encodeURIComponent(String(podcast.name || ''))) : '';
    }

    function makeArtworkTile(src, fallbackText, className) {
      var wrap = document.createElement('span');
      wrap.className = className;
      var mono = document.createElement('span');
      mono.className = 'art-monogram';
      mono.textContent = String(fallbackText || (getLocale() === 'en' ? 'P' : '播')).trim().slice(0, 1) || (getLocale() === 'en' ? 'P' : '播');
      wrap.appendChild(mono);
      if (src) {
        var img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        img.decoding = 'async';
        img.addEventListener('load', function () { wrap.classList.add('has-art'); });
        img.addEventListener('error', function () { img.remove(); });
        img.src = src;
        wrap.appendChild(img);
      }
      return wrap;
    }

    function renderCoverCollage(podcasts) {
      var section = byId('cover-collage');
      var strip = byId('cover-strip');
      if (!section || !strip) return;
      var withArt = (Array.isArray(podcasts) ? podcasts : []).filter(function (p) { return Boolean(subscriptionArtworkUrl(p)); });
      if (withArt.length < 2) { section.hidden = true; strip.replaceChildren(); return; }
      strip.replaceChildren();
      withArt.slice(0, 8).forEach(function (podcast) {
        var tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'cover-tile';
        tile.title = String(podcast.name || '');
        tile.appendChild(makeArtworkTile(subscriptionArtworkUrl(podcast), podcast.name, 'cover-art'));
        tile.addEventListener('click', function () { selectPodcast(String(podcast.name || '')); });
        strip.appendChild(tile);
      });
      var edition = byId('cover-edition');
      if (edition) {
        edition.textContent = new Date().toLocaleDateString(getLocale() === 'en' ? 'en-US' : 'zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) + ' · ' + t('cover.collection');
      }
      section.hidden = false;
    }

    function loadSubscriptions() {
      return fetch(browseApi('/subscriptions'))
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
        .catch(function (error) { addLog(t('subscription.load_failed') + errorMessage(error), 'error'); });
    }

    function getScopedSubscriptions() {
      if (!selectedPodcast) return _subscriptions.slice();
      return _subscriptions.filter(function (podcast) { return podcast && String(podcast.name || '') === selectedPodcast; });
    }

    function updateTimelineHeading() {
      var scopeCount = getScopedSubscriptions().length;
      var total = Number(_episodeCounts.all) || 0;
      byId('center-title').textContent = selectedPodcast || t('content.all_subscriptions');
      var pieces = [];
      if (getLocale() === 'en') {
        if (total) pieces.push('Chronological');
        if (selectedPodcast) pieces.push(total + ' episode' + (total === 1 ? '' : 's'));
        else if (scopeCount) pieces.push(scopeCount + ' show' + (scopeCount === 1 ? '' : 's') + ' · ' + total + ' episode' + (total === 1 ? '' : 's'));
        byId('center-sub').textContent = pieces.join(' · ') || (scopeCount ? t('subscription.loading') : t('subscription.add_first_hint'));
      } else {
        if (total) pieces.push(t('subscription.timeline'));
        if (selectedPodcast) pieces.push(t('subscription.episodes_count', total));
        else if (scopeCount) pieces.push(t('subscription.shows_episodes_count', scopeCount, total));
        byId('center-sub').textContent = pieces.join(' · ') || (scopeCount ? t('subscription.loading') : t('subscription.add_first_hint'));
      }
    }

    // 切换节目范围（全部订阅 / 某一档）：重置搜索、筛选与页码，再向服务端取第一页。
    function loadTimelineEpisodes(podcasts, force) {
      var scope = (Array.isArray(podcasts) ? podcasts : []).filter(function (podcast) { return podcast && podcast.name; });
      pageEpisodes = [];
      currentPage = 1;
      resetEpisodeInspector();
      byId('episode-search').value = '';
      byId('episode-search').disabled = !scope.length;
      currentFilter = 'all';
      setFilterButtons('all');
      setHidden(byId('refresh-btn'), !scope.length);
      setHidden(byId('episode-empty'), true);
      setHidden(byId('episode-list'), false);
      _episodeTotal = 0;
      _episodeCounts = { all: 0, readable: 0, unread: 0, read: 0 };
      if (!scope.length) {
        _timelineRequestToken += 1;
        updateTimelineHeading();
        renderEpisodeList();
        return Promise.resolve([]);
      }
      updateTimelineHeading();
      return loadEpisodePage(force);
    }

