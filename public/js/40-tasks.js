    function triggerEpisode(episode, event, force) {
      if (event) event.stopPropagation();
      var sourceName = String(episode.podcast_name || selectedPodcast || '').trim();
      var title = String(episode.title || '');
      if (!sourceName) { addLog(t('tasks.no_source'), 'error'); return; }
      if (!requireControl('generate', { podcast: sourceName })) return;
      var button = event && event.currentTarget && event.currentTarget.tagName === 'BUTTON' ? event.currentTarget : null;
      _currentTaskPodcastName = sourceName;
      var episodeKey = String(episode.id || '');
      // 客户端防抖：同一节目在提交完成前忽略后续点击，避免误触重复入队。
      if (_submittingEpisodes[episodeKey]) return;
      _submittingEpisodes[episodeKey] = true;
      if (button) button.disabled = true;
      setHidden(byId('task-card'), false);
      setTaskStatus(t('inspector.generating_head'), 0);
      var url = appUrl('/api/control/tasks');
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episode_id: String(episode.id || ''), force: !!force }),
      })
        .then(readApiResponse)
        .then(function (data) {
          if (data.status === 'existing') addLog(t('tasks.generating_progress'), 'info');
          watchTask(data.task_id, title, sourceName);
          ensureTaskCard(data.task_id).episodeId = episodeKey;
        })
        .catch(function (error) {
          if (error && error.status === 409) {
            setTaskStatus(error.message || t('tasks.already_generated'), 0);
            setTaskBadge('info', t('tasks.completed_badge'));
            addLog(error.message || t('tasks.already_generated_log'), 'info');
          } else {
            setTaskStatus(t('tasks.failed_retry_msg'), 0);
            setTaskBadge('error', t('tasks.failed_badge'));
          }
        })
        .finally(function () {
          delete _submittingEpisodes[episodeKey];
          if (button) button.disabled = false;
        });
    }

    function submitCustomTask() {
      if (!requireControl('import')) return;
      var uploadId = _uploadedAudioPath;
      var prompt = byId('custom-prompt').value.trim();
      var title = _uploadedAudioTitle || t('custom.custom_audio');
      if (!uploadId) { setHidden(byId('task-card'), false); setTaskStatus(t('tasks.need_audio_file'), 0); setTaskBadge('error', t('tasks.step_missing_badge')); return; }
      if (!prompt) { setHidden(byId('task-card'), false); setTaskStatus(t('tasks.need_prompt'), 0); setTaskBadge('error', t('tasks.step_missing_badge')); return; }
      var button = byId('custom-submit-btn');
      button.disabled = true; button.textContent = t('custom.generating');
      setHidden(byId('download-result-wrap'), true);
      setHidden(byId('task-card'), false);
      setTaskStatus(t('inspector.generating_head'), 0);
      fetch(appUrl('/api/control/tasks/custom'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upload_id: uploadId, title: title, custom_prompt: prompt })
      })
        .then(readApiResponse)
        .then(function (data) { watchTask(data.task_id, title, t('custom.local_audio')); })
        .catch(function (err) {
          setTaskStatus(t('tasks.failed_prefix') + (err.message || t('tasks.retry_hint')), 0);
          setTaskBadge('error', t('tasks.failed_badge'));
        })
        .finally(function () { button.disabled = false; button.textContent = t('custom.submit'); });
    }

    var STAGE_LABELS = { queued: '获取音频', resolving: '获取音频', downloading: '获取音频', transcribing: '转写', refining: '整理', finalizing: '保存', done: '保存', success: '保存', error: '失败', cancelled: '已取消' };
    var STAGE_STEP_INDEX = { queued: 0, resolving: 0, downloading: 0, transcribing: 1, refining: 2, finalizing: 3, done: 3, success: 3 };
    /**
     * 一个轮询器盯住所有进行中的任务：每轮只发一个 GET /tasks?active=true（不是每个任务一个定时器）。
     * 间隔 5 秒起，没有变化就逐步放慢到 15 秒，有变化立刻回到 5 秒；页面不可见时暂停，回到前台立刻补一轮。
     * 盯着的任务从进行中列表里消失 = 已结束：onFinished(id) 各取一次终态。
     */
    function createTaskPoller(options) {
      var MIN_DELAY = 5000;
      var MAX_DELAY = 15000;
      var watched = {};
      var timer = null;
      var inFlight = false;
      var delay = MIN_DELAY;
      function watchedIds() { return Object.keys(watched); }
      function stop() { if (timer !== null) { options.clearTimeout(timer); timer = null; } }
      function schedule(ms) {
        stop();
        if (!watchedIds().length || options.isHidden()) return;
        timer = options.setTimeout(tick, ms);
      }
      function tick() {
        timer = null;
        if (inFlight || !watchedIds().length) return;
        inFlight = true;
        options.fetchActive()
          .then(function (tasks) {
            var active = {};
            var changed = false;
            tasks.forEach(function (task) {
              var id = String(task.id || '');
              active[id] = true;
              if (!Object.prototype.hasOwnProperty.call(watched, id)) return;
              var signature = [task.status, task.stage, task.progress_pct, task.message].join('|');
              if (watched[id] !== signature) { watched[id] = signature; changed = true; options.onUpdate(task); }
            });
            watchedIds().forEach(function (id) {
              if (active[id]) return;
              delete watched[id];
              changed = true;
              options.onFinished(id);
            });
            delay = changed ? MIN_DELAY : Math.min(MAX_DELAY, Math.round(delay * 1.5));
          })
          .catch(function () { delay = Math.min(MAX_DELAY, Math.round(delay * 1.5)); })
          .then(function () { inFlight = false; schedule(delay); });
      }
      return {
        watch: function (taskId) {
          var id = String(taskId || '');
          if (!id || Object.prototype.hasOwnProperty.call(watched, id)) return;
          watched[id] = '';
          delay = MIN_DELAY;
          if (timer === null && !inFlight) schedule(MIN_DELAY);
        },
        unwatch: function (taskId) {
          if (taskId) delete watched[String(taskId)];
          else watched = {};
          if (!watchedIds().length) stop();
        },
        watchedIds: watchedIds,
        wake: function () {
          if (options.isHidden() || inFlight) return;
          stop();
          delay = MIN_DELAY;
          tick();
        }
      };
    }

    var _taskPoller = createTaskPoller({
      fetchActive: function () {
        return fetch(appUrl('/api/control/tasks?active=true')).then(readApiResponse).then(function (tasks) { return Array.isArray(tasks) ? tasks : []; });
      },
      onUpdate: function (task) {
        applyPublicTask(task);
        setTaskStatus(task.stage, task.progress_pct || 0, String(task.id), task.episode_title, task.message);
      },
      onFinished: function (id) {
        fetch(safeTaskUrl(id, ''))
          .then(readApiResponse)
          .then(function (task) {
            if (!task || !task.status) return;
            applyPublicTask(task);
            setTaskStatus(task.stage, task.progress_pct || 0, id, task.episode_title, task.message);
            if (task.status === 'success') handleTaskFinished(id, true, { message: task.message });
            else if (task.status === 'cancelled') handleTaskCancelled(id);
            else if (task.status === 'failed') handleTaskFinished(id, false, { stage: task.stage, progress: task.progress_pct, message: task.message });
          })
          .catch(function () {});
      },
      setTimeout: function (callback, ms) { return window.setTimeout(callback, ms); },
      clearTimeout: function (handle) { window.clearTimeout(handle); },
      isHidden: function () { return document.visibilityState === 'hidden'; }
    });
    document.addEventListener('visibilitychange', function () { _taskPoller.wake(); });

    function clearPolling(taskId) {
      _taskPoller.unwatch(taskId);
    }
    function closeActiveStream() {
      clearPolling();
    }
    function taskElapsed(startedAt) {
      var seconds = Math.max(0, Math.floor((Date.now() - (startedAt || Date.now())) / 1000));
      return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    }
    function resolveTaskFailureMessage(task) {
      if (!task) return t('fail.default');
      var stage = String(task.stage || '');
      if (getLocale() === 'en') {
        if (stage === 'downloading' || stage === 'queued' || stage === 'resolving') {
          return t('fail.audio');
        }
        if (stage === 'transcribing') {
          return t('fail.transcribe');
        }
        if (stage === 'refining') {
          return t('fail.refine');
        }
        if (stage === 'finalizing') {
          return t('fail.finalize');
        }
        if (task.status === 'cancelled') {
          return t('fail.cancelled');
        }
        return t('fail.default');
      }
      var msg = String(task.message || '').trim();
      var isChinese = /[\u4e00-\u9fa5]/.test(msg);
      if (msg && !/^([a-z0-9_]+|error|\[object.*\])$/i.test(msg) && (getLocale() !== 'en' || !isChinese)) {
        return msg;
      }
      if (stage === 'downloading' || stage === 'queued' || stage === 'resolving') {
        return t('fail.audio');
      }
      if (stage === 'transcribing') {
        return t('fail.transcribe');
      }
      if (stage === 'refining') {
        return t('fail.refine');
      }
      if (stage === 'finalizing') {
        return t('fail.finalize');
      }
      if (task.status === 'cancelled') {
        return t('fail.cancelled');
      }
      return t('fail.default');
    }

    function renderTaskQueue() {
      var list = byId('task-list');
      var ids = Object.keys(_taskCards).filter(function (id) {
        var s = _taskCards[id].status;
        return s === 'running' || s === 'pending' || s === 'failed' || s === 'cancelled';
      });
      var runningCount = ids.filter(function (id) { return _taskCards[id].status === 'running' || _taskCards[id].status === 'pending'; }).length;
      var attentionCount = ids.filter(function (id) { return _taskCards[id].status === 'failed' || _taskCards[id].status === 'cancelled'; }).length;

      setHidden(byId('task-card'), !ids.length);
      byId('task-queue-count').textContent = runningCount ? '（' + runningCount + '）' : (attentionCount ? '（' + attentionCount + '）' : '');

      var triggerBtn = byId('task-panel-btn');
      var triggerLabel = byId('task-trigger-label');
      var triggerDot = triggerBtn ? triggerBtn.querySelector('.task-trigger-dot') : null;

      if (runningCount > 0) {
        setHidden(triggerBtn, false);
        if (triggerLabel) triggerLabel.textContent = t('tasks.processing_count', runningCount);
        if (triggerDot) triggerDot.style.display = '';
      } else if (attentionCount > 0) {
        setHidden(triggerBtn, false);
        if (triggerLabel) triggerLabel.textContent = t('tasks.attention_count', attentionCount);
        if (triggerDot) triggerDot.style.display = 'none';
      } else {
        setHidden(triggerBtn, true);
      }

      list.replaceChildren();
      ids.reverse().forEach(function (id, index) {
        var task = _taskCards[id];
        var card = document.createElement('article'); card.className = 'task-queue-item'; card.style.setProperty('--item-index', index);
        var top = document.createElement('div'); top.className = 'task-topline';
        var title = document.createElement('h2'); title.textContent = task.title || t('tasks.default_title');
        var badge = document.createElement('span'); badge.className = 'badge ' + (task.status === 'success' ? 'badge-success' : (task.status === 'failed' || task.status === 'cancelled') ? 'badge-error' : 'badge-accent'); badge.textContent = task.status === 'success' ? t('stage.success') : task.status === 'cancelled' ? t('stage.cancelled') : task.status === 'failed' ? t('stage.failed') : task.progress + '%';
        top.append(title, badge);
        var stageLabel = t('stage.' + (task.stage || 'queued'));
        var meta = document.createElement('div'); meta.className = 'task-meta'; meta.innerHTML = '<span>' + escapeHtml(stageLabel) + '</span><span>' + task.progress + '%</span>';
        var status = document.createElement('h3'); status.className = 'task-stage'; status.setAttribute('aria-live', 'polite');
        if (task.status === 'failed' || task.status === 'cancelled') {
          status.textContent = resolveTaskFailureMessage(task);
        } else if (getLocale() === 'en') {
          status.textContent = stageLabel;
        } else {
          status.textContent = task.message || stageLabel;
        }
        var progress = document.createElement('div'); progress.className = 'progress-bar'; progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', '100'); progress.setAttribute('aria-valuenow', String(task.progress));
        var inner = document.createElement('div'); inner.className = 'progress-inner'; inner.style.width = task.progress + '%'; progress.appendChild(inner);
        var steps = document.createElement('div'); steps.className = 'task-steps';
        var activeStep = Object.prototype.hasOwnProperty.call(STAGE_STEP_INDEX, task.stage) ? STAGE_STEP_INDEX[task.stage] : -1;
        [t('stage.step_audio'), t('stage.step_transcribe'), t('stage.step_refine'), t('stage.step_save')].forEach(function (label, stepIndex) { var step = document.createElement('span'); step.textContent = label; step.className = stepIndex <= activeStep ? 'is-active' : ''; if (stepIndex < activeStep) { step.classList.add('is-done'); step.insertAdjacentHTML('afterbegin', uiIcon('check')); } steps.appendChild(step); });
        card.append(top, meta, status, progress, steps);
        if (task.status === 'running' || task.status === 'pending') {
          var cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.className = 'task-cancel';
          cancelBtn.textContent = t('tasks.cancel');
          cancelBtn.setAttribute('aria-label', t('tasks.cancel_aria', String(task.title || t('tasks.default_title'))));
          cancelBtn.addEventListener('click', function () { cancelTask(id, cancelBtn); });
          card.appendChild(cancelBtn);
        } else if (task.status === 'failed' || task.status === 'cancelled') {
          var actions = document.createElement('div'); actions.className = 'task-actions';
          if (id !== 'local') {
            var retryBtn = document.createElement('button'); retryBtn.type = 'button'; retryBtn.className = 'task-action task-action-primary'; retryBtn.textContent = t('tasks.retry'); retryBtn.addEventListener('click', function () { retryTask(id, retryBtn); });
            actions.appendChild(retryBtn);
          }
          var clearBtn = document.createElement('button'); clearBtn.type = 'button'; clearBtn.className = 'task-action'; clearBtn.textContent = t('tasks.delete'); clearBtn.addEventListener('click', function () { clearTask(id, clearBtn); });
          actions.appendChild(clearBtn); card.appendChild(actions);
        }
        list.appendChild(card);
      });
    }
    function clearTask(taskId, button) {
      var id = String(taskId || '');
      if (!id || !requireControl('tasks')) return;
      if (id === 'local') { delete _taskCards[id]; renderTaskQueue(); return; }
      if (button) { button.disabled = true; button.textContent = t('tasks.deleting'); }
      fetch(safeTaskUrl(id, ''), { method: 'DELETE' })
        .then(readApiResponse)
        .then(function () { delete _taskCards[id]; clearPolling(id); renderTaskQueue(); loadHistory(); addLog(t('tasks.dismissed'), 'info'); })
        .catch(function (error) { if (button) { button.disabled = false; button.textContent = t('tasks.delete'); } addLog(errorMessage(error), 'warning'); });
    }
    function retryTask(taskId, button) {
      if (!requireControl('tasks')) return;
      var id = String(taskId || '');
      var oldTask = _taskCards[id];
      if (!id || !oldTask) return;
      if (button) { button.disabled = true; button.textContent = t('tasks.retrying'); }
      fetch(safeTaskUrl(id, '/retry'), { method: 'POST' })
        .then(readApiResponse)
        .then(function (data) {
          delete _taskCards[id]; clearPolling(id);
          watchTask(data.task_id, oldTask.title);
          loadHistory(); addLog(t('tasks.restarted'), 'info');
        })
        .catch(function (error) { if (button) { button.disabled = false; button.textContent = t('tasks.retry'); } addLog(errorMessage(error), 'warning'); });
    }
    function cancelTask(taskId, button) {
      var id = String(taskId || '');
      if (!id || !requireControl('tasks')) return;
      if (button) { button.disabled = true; button.textContent = t('tasks.cancelling'); }
      fetch(safeTaskUrl(id, ''), { method: 'DELETE' })
        .then(readApiResponse)
        .then(function () {
          addLog(t('tasks.cancelling_msg'), 'info');
          if (_taskCards[id]) { _taskCards[id].message = t('tasks.cancelling'); renderTaskQueue(); }
        })
        .catch(function (error) {
          addLog(error && error.message ? error.message : t('fail.default'), 'warning');
          if (button) { button.disabled = false; button.textContent = t('tasks.cancel_task'); }
        });
    }
    function ensureTaskCard(taskId, title, podcastName) {
      var id = String(taskId || 'local');
      if (!_taskCards[id]) _taskCards[id] = { stage: 'queued', progress: 0, status: 'running', startedAt: Date.now(), message: t('stage.queued') };
      var card = _taskCards[id];
      if (podcastName !== undefined && podcastName !== null && podcastName !== '') card.podcastName = String(podcastName).trim();
      if (title !== undefined && title !== null && title !== '') card.episodeTitle = String(title).trim();
      card.title = card.episodeTitle || card.title || t('tasks.default_title');
      card.isCustomUpload = (card.podcastName === '本地音频' || card.podcastName === '自定义音频' || card.podcastName === t('custom.local_audio') || card.podcastName === t('custom.custom_audio') || id === 'local');
      _taskStartedAt[id] = card.startedAt;
      return card;
    }
    function applyPublicTask(task) {
      var id = String(task.id || ''); if (!id) return null;
      if (task.podcast_name) _currentTaskPodcastName = String(task.podcast_name);
      var card = ensureTaskCard(id, task.episode_title, task.podcast_name);
      if (task.episode_id) card.episodeId = String(task.episode_id);
      card.status = String(task.status || 'pending');
      card.stage = String(task.stage || 'queued');
      card.progress = Math.max(0, Math.min(100, Number(task.progress_pct) || 0));
      if (card.status === 'failed' || card.status === 'cancelled') {
        card.message = resolveTaskFailureMessage(task);
      } else if (getLocale() === 'en') {
        card.message = t('stage.' + card.stage);
      } else {
        card.message = String(task.message || t('stage.' + card.stage));
      }
      card.startedAt = new Date(task.created_at || Date.now()).getTime();
      return card;
    }
    function handleTaskFinished(taskId, succeeded, details) {
      var task = ensureTaskCard(taskId);
      details = details || {};
      task.status = succeeded ? 'success' : 'failed';
      if (succeeded) {
        task.stage = 'done';
        task.progress = 100;
        task.message = details.message || t('tasks.success_msg');
      } else {
        if (details.stage) task.stage = details.stage;
        task.progress = Math.max(task.progress || 0, Number(details.progress) || 0);
        task.message = details.message ? resolveTaskFailureMessage({ stage: task.stage, message: details.message }) : resolveTaskFailureMessage(task);
      }
      renderTaskQueue();
      loadHistory();
      if (succeeded) {
        loadLibrary();
        byId('download-result-btn').href = safeTaskUrl(taskId, '/download');
        byId('read-result-btn').onclick = function () { openManuscript(taskId); };
        setHidden(byId('download-result-wrap'), false);
        addLog(t('tasks.success_log'), 'success');
      } else {
        addLog(task.message || t('tasks.failed_log'), 'error');
      }
      setPodcastDot(_currentTaskPodcastName || selectedPodcast, succeeded ? 'var(--success)' : 'var(--error)', false);
    }
    function handleTaskCancelled(taskId) {
      var task = ensureTaskCard(taskId);
      task.status = 'cancelled';
      task.message = task.message || t('fail.cancelled');
      clearPolling(String(taskId || ''));
      renderTaskQueue();
      loadHistory();
      addLog(t('tasks.cancelled_msg'), 'info');
      setPodcastDot(_currentTaskPodcastName || selectedPodcast, 'var(--error)', false);
    }
    function startPolling(taskId) {
      _taskPoller.watch(taskId);
    }
    function watchTask(taskId, title, podcastName) {
      _currentTaskId = String(taskId || '');
      if (_currentTaskId !== 'local' && _taskCards.local && !_taskCards[_currentTaskId]) {
        _taskCards[_currentTaskId] = _taskCards.local; delete _taskCards.local;
      }
      ensureTaskCard(_currentTaskId, title, podcastName);
      renderTaskQueue();
      startPolling(_currentTaskId);
      setPodcastDot(_currentTaskPodcastName || podcastName || selectedPodcast, 'var(--rust)', true);
    }

    function setPodcastDot(name, color, pulsing) {
      if (!name) return;
      document.querySelectorAll('.podcast-item').forEach(function (item) {
        if (item.dataset.name === name && item._statusDot) { item._statusDot.style.background = color; item._statusDot.classList.toggle('dot-pulse', Boolean(pulsing)); }
      });
    }

    function loadHistory() {
      return fetch(appUrl('/api/control/tasks'))
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
        .then(function (tasks) {
          _taskHistory = Array.isArray(tasks) ? tasks : [];
          var visibleTaskIds = {};
          var activeTaskIds = {};
          _taskHistory.forEach(function (task) {
            if (task.status === 'pending' || task.status === 'running') {
              visibleTaskIds[String(task.id)] = true;
              activeTaskIds[String(task.id)] = true;
              applyPublicTask(task);
              startPolling(task.id);
            } else if (task.status === 'failed' || task.status === 'cancelled') {
              visibleTaskIds[String(task.id)] = true;
              applyPublicTask(task);
            }
          });
          _taskPoller.watchedIds().forEach(function (id) {
            if (!activeTaskIds[id]) clearPolling(id);
          });
          Object.keys(_taskCards).forEach(function (id) {
            if (id !== 'local' && !visibleTaskIds[id] && _taskCards[id].status !== 'success') delete _taskCards[id];
          });
          renderTaskQueue();
          if (pageEpisodes.length) {
            // 任务结束会改变「未生成 / 待读」筛选与计数：静默重取当前页
            reloadEpisodePage();
            if (selectedEpisode) renderEpisodeInspector(selectedEpisode);
          }
        })
        .catch(function () {});
    }

    function renderLibrary(articles) {
      var list = byId('library-list');
      var query = String(byId('library-search').value || '').trim().toLowerCase();
      list.replaceChildren();
      var visible = (Array.isArray(articles) ? articles : []).filter(function (article) {
        var matchesQuery = !query || String(article.title || article.episode_title || '').toLowerCase().includes(query) || String(article.podcast_name || '').toLowerCase().includes(query);
        var read = isRead({ episode_id: article.episode_id, task_id: article.task_id });
        var matchesState = _libraryFilter === 'all' || (_libraryFilter === 'read' ? read : !read);
        return matchesQuery && matchesState;
      });
      if (!visible.length && query) {
        list.innerHTML = '<div class="library-empty">' + uiIcon('book-open') + '<strong>' + escapeHtml(t('library.empty_query')) + '</strong><span>' + escapeHtml(t('library.empty_query_hint')) + '</span></div>';
        return;
      }
      if (!visible.length) {
        list.innerHTML = '<div class="library-empty">' + uiIcon('book-open') + '<strong>' + escapeHtml(t('library.empty')) + '</strong><span>' + escapeHtml(t('library.empty_hint')) + '</span><div class="button-row"><button type="button" data-empty-mode="podcast">' + escapeHtml(t('library.view_subscriptions')) + '</button><button type="button" data-empty-mode="custom">' + escapeHtml(t('library.import_audio')) + '</button></div></div>';
        list.querySelectorAll('[data-empty-mode]').forEach(function (button) { button.addEventListener('click', function () { switchMode(button.dataset.emptyMode); }); });
        return;
      }
      visible.forEach(function (article, index) {
        var taskId = String(article.task_id || article.id || '');
        var item = document.createElement('article'); item.className = 'library-item'; item.style.setProperty('--item-index', index);
        var copy = document.createElement('div');
        var source = document.createElement('span'); source.className = 'library-source'; source.textContent = String(article.podcast_name || t('custom.local_audio'));
        var title = document.createElement('strong'); title.textContent = String(article.title || article.episode_title || t('episode.untitled'));
        var meta = document.createElement('span'); meta.textContent = new Date(article.updated_at || article.created_at).toLocaleDateString(getLocale() === 'en' ? 'en-US' : 'zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
        copy.append(source, title, meta);
        var actions = document.createElement('div'); actions.className = 'library-actions';
        var read = document.createElement('button'); read.type = 'button'; read.className = 'episode-action'; read.textContent = t('library.read'); read.addEventListener('click', function () { openManuscript(taskId, null, article); });
        var download = document.createElement('a'); download.className = 'download-btn'; download.href = articleUrl(taskId, '/download'); download.download = ''; download.innerHTML = uiIcon('download');
        var dlText = document.createTextNode(t('library.download'));
        download.appendChild(dlText);
        actions.append(read, download); item.append(copy, actions); list.appendChild(item);
      });
    }

    function loadLibrary(articles) {
      if (Array.isArray(articles) && articles.length) { _libraryArticles = articles; renderLibrary(_libraryArticles); return Promise.resolve(_libraryArticles); }
      return fetch(browseApi('/articles?limit=200'))
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
        .then(function (data) { _libraryArticles = Array.isArray(data) ? data : []; renderLibrary(_libraryArticles); return _libraryArticles; })
        .catch(function (error) { addLog(t('library.load_failed') + errorMessage(error), 'warning'); });
    }

    var _toastState = {};
    function addLog(message, level) {
      var allowed = ['info', 'running', 'success', 'error', 'warning'];
      var safeLevel = allowed.indexOf(level) >= 0 ? level : 'info';
      var text = String(message == null ? '' : message);
      var key = safeLevel + '|' + text;
      var now = Date.now();
      if (_toastState[key] && now - _toastState[key].time < 2000) { _toastState[key].count += 1; _toastState[key].node.querySelector('.toast-copy').textContent = text + ' ×' + _toastState[key].count; _toastState[key].time = now; return; }
      var toast = document.createElement('div'); toast.className = 'toast toast-' + safeLevel; toast.setAttribute('role', safeLevel === 'error' ? 'alert' : 'status');
      var icon = document.createElement('span'); icon.className = 'toast-icon'; icon.innerHTML = uiIcon(safeLevel === 'success' ? 'check-circle' : (safeLevel === 'error' || safeLevel === 'warning') ? 'alert-circle' : 'info');
      var copy = document.createElement('span'); copy.className = 'toast-copy'; copy.textContent = text;
      var close = document.createElement('button'); close.type = 'button'; close.className = 'toast-close'; close.setAttribute('aria-label', t('toast.close')); close.innerHTML = uiIcon('close');
      close.addEventListener('click', function () { toast.remove(); delete _toastState[key]; }); toast.append(icon, copy, close); byId('toast-container').appendChild(toast);
      _toastState[key] = { node: toast, time: now, count: 1 };
      if (safeLevel === 'info' || safeLevel === 'running' || safeLevel === 'success') setTimeout(function () { if (toast.isConnected) toast.remove(); delete _toastState[key]; }, 4000);
    }

    function setTaskStatus(stage, progress, taskId, title, message) {
      var id = String(taskId || _currentTaskId || 'local');
      var task = ensureTaskCard(id, title);
      var normalizedStage = String(stage || 'queued').toLowerCase();
      if (Object.prototype.hasOwnProperty.call(STAGE_LABELS, normalizedStage)) task.stage = normalizedStage;
      else if (!message) message = String(stage || '');
      task.progress = Math.max(0, Math.min(100, Number(progress) || 0));
      task.message = message || (task.progress >= 100 ? t('tasks.success_msg') : t('stage.' + task.stage));
      renderTaskQueue();
      if (pageEpisodes.length) renderEpisodeList();
      if (selectedEpisode) renderEpisodeInspector(selectedEpisode);
    }

    function setTaskBadge(type, text) {
      var task = ensureTaskCard(_currentTaskId || 'local'); task.status = type === 'success' ? 'success' : type === 'error' ? 'failed' : 'running'; task.message = text; renderTaskQueue();
    }
