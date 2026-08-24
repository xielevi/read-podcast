    function triggerEpisode(podcastName, title, event, force) {
      if (event) event.stopPropagation();
      var sourceName = String(podcastName || selectedPodcast || '').trim();
      if (!sourceName) { addLog('错误：未找到节目来源', 'error'); return; }
      var button = event && event.currentTarget && event.currentTarget.tagName === 'BUTTON' ? event.currentTarget : null;
      _currentTaskPodcastName = sourceName;
      var episodeKey = sourceName + '::' + title;
      // 客户端防抖：同一节目在提交完成前忽略后续点击，避免误触重复入队。
      if (_submittingEpisodes[episodeKey]) return;
      _submittingEpisodes[episodeKey] = true;
      if (button) button.disabled = true;
      setHidden(byId('task-card'), false);
      setTaskStatus('正在转录', 0);
      var url = appUrl('/api/read-podcast/tasks');
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ podcast_name: sourceName, episode_title: title, force: !!force }),
      })
        .then(function (response) {
          return response.json().then(function (data) {
            if (!response.ok) { var err = new Error(data.detail || ('HTTP ' + response.status)); err.status = response.status; throw err; }
            return data;
          });
        })
        .then(function (data) {
          if (data.status === 'existing') addLog('该节目已在转录队列中，已切换到进行中的任务。', 'info');
          subscribeSSE(data.task_id, title);
        })
        .catch(function (error) {
          if (error && error.status === 409) {
            setTaskStatus(error.message || '该节目已转录完成，如需重做请点击「重新转录」。', 0);
            setTaskBadge('info', '已完成');
            addLog(error.message || '节目已转录完成', 'info');
          } else {
            setTaskStatus('这次没有转录成功，请稍后再试。', 0);
            setTaskBadge('error', '未成功');
          }
        })
        .finally(function () {
          delete _submittingEpisodes[episodeKey];
          if (button) button.disabled = false;
        });
    }

    function submitCustomTask() {
      var audioPath = _uploadedAudioPath;
      var prompt = byId('custom-prompt').value.trim();
      if (!audioPath) { setHidden(byId('task-card'), false); setTaskStatus('请先选择音频文件。', 0); setTaskBadge('error', '还差一步'); return; }
      if (!prompt) { setHidden(byId('task-card'), false); setTaskStatus('请选择一种文字样式。', 0); setTaskBadge('error', '还差一步'); return; }
      var button = byId('custom-submit-btn');
      button.disabled = true; button.textContent = '转录中…';
      setHidden(byId('download-result-wrap'), true);
      setHidden(byId('task-card'), false);
      setTaskStatus('正在转录', 0);
      fetch(appUrl('/api/read-podcast/tasks/custom'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio_filename: audioPath, custom_prompt: prompt }) })
        .then(function (response) { return response.json().then(function (data) { if (!response.ok || data.detail) throw new Error(data.detail || 'HTTP ' + response.status); return data; }); })
        .then(function (data) { subscribeSSE(data.task_id, audioPath); })
        .catch(function () { setTaskStatus('这次没有转录成功，请稍后再试。', 0); setTaskBadge('error', '未成功'); })
        .finally(function () { button.disabled = false; button.textContent = '转录'; });
    }

    var _pollTimers = {};
    var STAGE_LABELS = { queued: '准备', resolving: '准备', downloading: '下载', transcribing: '转录', refining: '精修', finalizing: '生成', done: '完成', error: '失败', cancelled: '已取消' };
    var STAGE_STEP_INDEX = { queued: 0, resolving: 0, downloading: 1, transcribing: 2, refining: 3, finalizing: 4, done: 4 };
    function clearPolling(taskId) {
      if (taskId) {
        if (_pollTimers[taskId]) { clearInterval(_pollTimers[taskId]); delete _pollTimers[taskId]; }
        return;
      }
      Object.keys(_pollTimers).forEach(function (id) { clearPolling(id); });
    }
    function closeActiveStream() {
      clearPolling();
      if (activeEventSource) { activeEventSource.close(); activeEventSource = null; }
      if (globalEventSource) { globalEventSource.close(); globalEventSource = null; }
    }
    function taskElapsed(startedAt) {
      var seconds = Math.max(0, Math.floor((Date.now() - (startedAt || Date.now())) / 1000));
      return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    }
    function renderTaskQueue() {
      var list = byId('task-list');
      var ids = Object.keys(_taskCards);
      setHidden(byId('task-card'), !ids.length);
      byId('task-queue-count').textContent = ids.length ? ids.length + ' 项' : '';
      list.replaceChildren();
      ids.reverse().forEach(function (id, index) {
        var task = _taskCards[id];
        var card = document.createElement('article'); card.className = 'task-queue-item'; card.style.setProperty('--item-index', index);
        var top = document.createElement('div'); top.className = 'task-topline';
        var title = document.createElement('h2'); title.textContent = task.title || '转录任务';
        var badge = document.createElement('span'); badge.className = 'badge ' + (task.status === 'success' ? 'badge-success' : (task.status === 'failed' || task.status === 'cancelled') ? 'badge-error' : 'badge-accent'); badge.textContent = task.status === 'success' ? '已完成' : task.status === 'cancelled' ? '已取消' : task.status === 'failed' ? '未成功' : '转录中';
        top.append(title, badge);
        var meta = document.createElement('div'); meta.className = 'task-meta'; meta.innerHTML = '<span>' + escapeHtml(STAGE_LABELS[task.stage] || '处理中') + ' · ' + escapeHtml(taskElapsed(task.startedAt)) + '</span><span>' + task.progress + '%</span>';
        var status = document.createElement('h3'); status.className = 'task-stage'; status.setAttribute('aria-live', 'polite'); status.textContent = task.message || ('正在' + (STAGE_LABELS[task.stage] || '处理') + '…');
        var progress = document.createElement('div'); progress.className = 'progress-bar'; progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', '100'); progress.setAttribute('aria-valuenow', String(task.progress));
        var inner = document.createElement('div'); inner.className = 'progress-inner'; inner.style.width = task.progress + '%'; progress.appendChild(inner);
        var steps = document.createElement('div'); steps.className = 'task-steps';
        var activeStep = Object.prototype.hasOwnProperty.call(STAGE_STEP_INDEX, task.stage) ? STAGE_STEP_INDEX[task.stage] : -1;
        ['准备', '下载', '转录', '精修', '生成'].forEach(function (label, stepIndex) { var step = document.createElement('span'); step.textContent = label; step.className = stepIndex <= activeStep ? 'is-active' : ''; steps.appendChild(step); });
        card.append(top, meta, status, progress, steps);
        if (task.status === 'running' || task.status === 'pending') {
          var cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.className = 'task-cancel';
          cancelBtn.textContent = '取消任务';
          cancelBtn.setAttribute('aria-label', '取消「' + String(task.title || '转录任务') + '」');
          cancelBtn.addEventListener('click', function () { cancelTask(id, cancelBtn); });
          card.appendChild(cancelBtn);
        } else if (task.status === 'failed' || task.status === 'cancelled') {
          var actions = document.createElement('div'); actions.className = 'task-actions';
          if (id !== 'local') {
            var retryBtn = document.createElement('button'); retryBtn.type = 'button'; retryBtn.className = 'task-action task-action-primary'; retryBtn.textContent = '重试'; retryBtn.addEventListener('click', function () { retryTask(id, retryBtn); });
            actions.appendChild(retryBtn);
          }
          var clearBtn = document.createElement('button'); clearBtn.type = 'button'; clearBtn.className = 'task-action'; clearBtn.textContent = '清理'; clearBtn.addEventListener('click', function () { clearTask(id, clearBtn); });
          actions.appendChild(clearBtn); card.appendChild(actions);
        }
        list.appendChild(card);
      });
    }
    function clearTask(taskId, button) {
      var id = String(taskId || '');
      if (!id) return;
      if (id === 'local') { delete _taskCards[id]; renderTaskQueue(); return; }
      if (button) { button.disabled = true; button.textContent = '清理中…'; }
      fetch(safeTaskUrl(id, ''), { method: 'DELETE' })
        .then(function (response) { return response.json().then(function (data) { if (!response.ok) throw new Error(data.detail || ('HTTP ' + response.status)); return data; }); })
        .then(function () { delete _taskCards[id]; clearPolling(id); renderTaskQueue(); loadHistory(); addLog('失败记录已清理，原音频仍然保留。', 'info'); })
        .catch(function (error) { if (button) { button.disabled = false; button.textContent = '清理'; } addLog(errorMessage(error), 'warning'); });
    }
    function retryTask(taskId, button) {
      var id = String(taskId || '');
      var oldTask = _taskCards[id];
      if (!id || !oldTask) return;
      if (button) { button.disabled = true; button.textContent = '重试中…'; }
      fetch(safeTaskUrl(id, '/retry'), { method: 'POST' })
        .then(function (response) { return response.json().then(function (data) { if (!response.ok) throw new Error(data.detail || ('HTTP ' + response.status)); return data; }); })
        .then(function (data) {
          delete _taskCards[id]; clearPolling(id);
          subscribeSSE(data.task_id, oldTask.title);
          loadHistory(); addLog('已使用保留的原音频重新排队。', 'info');
        })
        .catch(function (error) { if (button) { button.disabled = false; button.textContent = '重试'; } addLog(errorMessage(error), 'warning'); });
    }
    function cancelTask(taskId, button) {
      var id = String(taskId || '');
      if (!id) return;
      if (button) { button.disabled = true; button.textContent = '取消中…'; }
      fetch(safeTaskUrl(id, ''), { method: 'DELETE' })
        .then(function (response) {
          return response.json().then(function (data) {
            if (!response.ok) { var err = new Error(data.detail || ('HTTP ' + response.status)); err.status = response.status; throw err; }
            return data;
          });
        })
        .then(function () {
          addLog('已发送取消请求，正在停止任务…', 'info');
          if (_taskCards[id]) { _taskCards[id].message = '正在取消…'; renderTaskQueue(); }
        })
        .catch(function (error) {
          addLog(error && error.message ? error.message : '取消任务失败', 'warning');
          if (button) { button.disabled = false; button.textContent = '取消任务'; }
        });
    }
    function ensureTaskCard(taskId, title) {
      var id = String(taskId || 'local');
      if (!_taskCards[id]) _taskCards[id] = { title: title || '转录任务', stage: 'queued', progress: 0, status: 'running', startedAt: Date.now(), message: '已加入整理流水线…' };
      if (title) _taskCards[id].title = title;
      _taskStartedAt[id] = _taskCards[id].startedAt;
      return _taskCards[id];
    }
    function applyPublicTask(task) {
      var id = String(task.id || ''); if (!id) return null;
      if (task.podcast_name) _currentTaskPodcastName = String(task.podcast_name);
      var card = ensureTaskCard(id, task.episode_title);
      card.status = String(task.status || 'pending');
      card.stage = String(task.stage || 'queued');
      card.progress = Math.max(0, Math.min(100, Number(task.progress_pct) || 0));
      card.message = String(task.message || '');
      card.startedAt = new Date(task.created_at || Date.now()).getTime();
      return card;
    }
    function handleTaskFinished(taskId, succeeded, details) {
      var task = ensureTaskCard(taskId);
      details = details || {};
      task.status = succeeded ? 'success' : 'failed';
      if (succeeded) { task.stage = 'done'; task.progress = 100; }
      else {
        if (details.stage) task.stage = details.stage;
        if (details.progress !== undefined) task.progress = Math.max(0, Math.min(100, Number(details.progress) || 0));
      }
      task.message = details.message || (succeeded ? '文字已经准备好了。' : '转录或整理未成功；原音频已保留，可直接重试。');
      renderTaskQueue();
      loadHistory();
      if (succeeded) {
        byId('download-result-btn').href = safeTaskUrl(taskId, '/download');
        byId('read-result-btn').onclick = function () { openManuscript(taskId); };
        setHidden(byId('download-result-wrap'), false);
        addLog('任务全流程处理成功', 'success');
      } else addLog('任务处理失败', 'error');
      setPodcastDot(_currentTaskPodcastName || selectedPodcast, succeeded ? 'var(--success)' : 'var(--error)', false);
    }
    function handleTaskCancelled(taskId) {
      var task = ensureTaskCard(taskId);
      task.status = 'cancelled'; task.message = task.message || '任务已取消；原音频已保留，可直接重试。';
      clearPolling(String(taskId || ''));
      renderTaskQueue();
      loadHistory();
      addLog('任务已取消', 'info');
      setPodcastDot(_currentTaskPodcastName || selectedPodcast, 'var(--error)', false);
    }
    function startPolling(taskId) {
      var id = String(taskId || '');
      if (!id || _pollTimers[id]) return;
      _pollTimers[id] = setInterval(function () {
        fetch(safeTaskUrl(id, ''))
          .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
          .then(function (task) {
            if (!task || !task.status) return;
            applyPublicTask(task);
            setTaskStatus(task.stage, task.progress_pct || 0, id, task.episode_title, task.message);
            if (task.status === 'success') { clearPolling(id); handleTaskFinished(id, true, { message: task.message }); }
            else if (task.status === 'cancelled') { clearPolling(id); handleTaskCancelled(id); }
            else if (task.status === 'failed') { clearPolling(id); handleTaskFinished(id, false, { stage: task.stage, progress: task.progress_pct, message: task.message }); }
          })
          .catch(function () {});
      }, 3000);
    }
    function ensureGlobalSSE() {
      if (globalEventSource) return;
      globalEventSource = new EventSource(appUrl('/api/read-podcast/tasks/stream'));
      globalEventSource.onmessage = function (event) {
        var data;
        try { data = JSON.parse(event.data); } catch (error) { addLog('收到无法解析的日志事件', 'warning'); return; }
        var id = String(data.task_id || _currentTaskId || ''); if (!id) return;
        ensureTaskCard(id);
        var level = data.level === 'done' ? 'success' : (data.progress > 0 && data.progress < 100 ? 'running' : data.level);
        addLog(data.message, level);
        if (data.progress !== undefined) setTaskStatus(data.stage, data.progress, id, null, data.message);
        if (data.status === 'cancelled' || data.stage === 'cancelled') handleTaskCancelled(id);
        else if (data.level === 'done' || data.level === 'error') handleTaskFinished(id, data.level === 'done', data);
        else { _taskCards[id].status = 'running'; setPodcastDot(_currentTaskPodcastName || selectedPodcast, 'var(--rust)', true); }
      };
      globalEventSource.onerror = function () {
        if (globalEventSource) { globalEventSource.close(); globalEventSource = null; }
        addLog('日志流已断开，切换至轮询模式……', 'info');
        Object.keys(_taskCards).filter(function (id) { return _taskCards[id].status === 'running'; }).forEach(startPolling);
      };
    }
    function subscribeSSE(taskId, title) {
      _currentTaskId = String(taskId || '');
      if (_currentTaskId !== 'local' && _taskCards.local && !_taskCards[_currentTaskId]) {
        _taskCards[_currentTaskId] = _taskCards.local; delete _taskCards.local;
      }
      ensureTaskCard(_currentTaskId, title);
      renderTaskQueue();
      ensureGlobalSSE();
      setPodcastDot(_currentTaskPodcastName || selectedPodcast, 'var(--rust)', true);
    }

    function setPodcastDot(name, color, pulsing) {
      if (!name) return;
      document.querySelectorAll('.podcast-item').forEach(function (item) {
        if (item.dataset.name === name && item._statusDot) { item._statusDot.style.background = color; item._statusDot.classList.toggle('dot-pulse', Boolean(pulsing)); }
      });
    }

    function loadHistory() {
      return fetch(appUrl('/api/read-podcast/tasks'))
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
        .then(function (tasks) {
          _taskHistory = Array.isArray(tasks) ? tasks : [];
          _taskHistoryMap = {};
          _taskHistory.forEach(function (task) {
            var key = task.podcast_name + '::' + task.episode_title;
            if (task.status === 'success' && !_taskHistoryMap[key]) {
              _taskHistoryMap[key] = task;
            }
          });
          var visibleTaskIds = {};
          _taskHistory.forEach(function (task) {
            if (task.status === 'pending' || task.status === 'running' || task.status === 'failed' || task.status === 'cancelled') {
              visibleTaskIds[String(task.id)] = true;
              applyPublicTask(task);
              if (task.status === 'pending' || task.status === 'running') startPolling(task.id);
            }
          });
          Object.keys(_taskCards).forEach(function (id) {
            if (id !== 'local' && !visibleTaskIds[id] && _taskCards[id].status !== 'success') delete _taskCards[id];
          });
          renderTaskQueue();
          fetchAllPages('/api/read-podcast/tasks/completed-keys')
            .then(function (completed) {
              _taskHistoryMap = {};
              (Array.isArray(completed) ? completed : []).forEach(function (item) { _taskHistoryMap[item.key] = _taskHistory.find(function (task) { return String(task.id) === String(item.task_id); }) || { id: item.task_id, status: 'success', podcast_name: item.key.split('::')[0], episode_title: item.key.split('::').slice(1).join('::') }; });
            })
            .catch(function () {})
            .finally(function () { renderHistory(_taskHistory.slice(0, 7)); });
          loadLibrary(_taskHistory);
          if (allEpisodes.length) {
            renderEpisodeList(getFilteredEpisodes());
            if (selectedEpisode) renderEpisodeInspector(selectedEpisode);
          }
        })
        .catch(function () {});
    }

    function renderHistory(tasks) {
      var list = byId('history-list');
      list.replaceChildren();
      if (!tasks.length) { list.innerHTML = '<p class="history-empty">完成稿件会出现在这里。</p>'; return; }
      tasks.forEach(function (task, index) {
        var succeeded = task.status === 'success';
        var item = document.createElement('button'); item.type = 'button'; item.className = 'history-item'; item.style.setProperty('--item-index', index);
        var copy = document.createElement('span'); copy.style.minWidth = '0';
        var title = document.createElement('span'); title.className = 'history-title'; title.style.display = 'block'; title.textContent = String(task.episode_title || '未命名任务');
        var source = document.createElement('span'); source.className = 'history-source'; source.style.display = 'block'; source.textContent = String(task.podcast_name || '自定义');
        copy.append(title, source);
        var badge = document.createElement('span'); badge.className = 'badge ' + (succeeded ? 'badge-success' : task.status === 'failed' ? 'badge-error' : 'badge-accent'); badge.textContent = succeeded ? '阅读' : task.status === 'failed' ? '失败' : '进行中';
        item.append(copy, badge);
        item.addEventListener('click', function () { if (succeeded) openManuscript(task.id); else { applyPublicTask(task); renderTaskQueue(); } });
        list.appendChild(item);
      });
    }

    function renderLibrary(tasks) {
      var list = byId('library-list');
      var query = String(byId('library-search').value || '').trim().toLowerCase();
      list.replaceChildren();
      var visible = (Array.isArray(tasks) ? tasks : []).filter(function (task) {
        return task.status === 'success' && (!query || String(task.episode_title || '').toLowerCase().includes(query));
      });
      if (!visible.length) { list.innerHTML = '<p class="library-empty">暂时没有匹配的稿件。</p>'; return; }
      visible.forEach(function (task, index) {
        var item = document.createElement('article'); item.className = 'library-item'; item.style.setProperty('--item-index', index);
        var copy = document.createElement('div');
        var title = document.createElement('strong'); title.textContent = String(task.episode_title || '未命名任务');
        var meta = document.createElement('span'); meta.textContent = String(task.podcast_name || '本地音频') + ' · ' + new Date(task.updated_at || task.created_at).toLocaleString('zh-CN');
        copy.append(title, meta);
        var actions = document.createElement('div'); actions.className = 'library-actions';
        var read = document.createElement('button'); read.type = 'button'; read.className = 'episode-action'; read.textContent = '阅读'; read.addEventListener('click', function () { openManuscript(task.id); });
        var download = document.createElement('a'); download.className = 'download-btn'; download.href = safeTaskUrl(task.id, '/download'); download.download = ''; download.textContent = '下载';
        actions.append(read, download); item.append(copy, actions); list.appendChild(item);
      });
    }

    function loadLibrary(tasks) {
      if (Array.isArray(tasks) && tasks.length) { _libraryTasks = tasks; renderLibrary(_libraryTasks); return Promise.resolve(_libraryTasks); }
      return fetch(appUrl('/api/read-podcast/tasks?limit=200'))
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
        .then(function (data) { _libraryTasks = Array.isArray(data) ? data : []; renderLibrary(_libraryTasks); return _libraryTasks; })
        .catch(function (error) { addLog('稿件库加载失败：' + errorMessage(error), 'warning'); });
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
      var copy = document.createElement('span'); copy.className = 'toast-copy'; copy.textContent = text;
      var close = document.createElement('button'); close.type = 'button'; close.className = 'toast-close'; close.setAttribute('aria-label', '关闭提示'); close.textContent = '×';
      close.addEventListener('click', function () { toast.remove(); delete _toastState[key]; }); toast.append(copy, close); byId('toast-container').appendChild(toast);
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
      task.message = message || (task.progress >= 100 ? '文字已经准备好了。' : ('正在' + (STAGE_LABELS[task.stage] || '处理') + '…'));
      renderTaskQueue();
    }

    function setTaskBadge(type, text) {
      var task = ensureTaskCard(_currentTaskId || 'local'); task.status = type === 'success' ? 'success' : type === 'error' ? 'failed' : 'running'; task.message = text; renderTaskQueue();
    }
