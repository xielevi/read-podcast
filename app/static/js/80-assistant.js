    // ── AI 阅读助手（百科查询 + 文字稿问答）──────────────────
    var _assistantAvailable = false;
    var _assistantHistory = [];
    var _assistantBusy = false;
    var _lookupTerm = '';
    var _lookupContext = '';

    function formatAssistantText(text) {
      // 轻量渲染：转义后处理 **加粗** 与换行，避免引入完整 Markdown 解析。
      var safe = escapeHtml(text);
      safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      return safe.replace(/\n/g, '<br>');
    }

    function appendAssistantMessage(role, text, options) {
      var opts = options || {};
      var container = opts.container || byId('assistant-messages');
      var hint = container.querySelector('.assistant-hint');
      if (hint) hint.remove();
      var bubble = document.createElement('div');
      bubble.className = 'assistant-msg assistant-msg-' + role + (opts.pending ? ' is-pending' : '') + (opts.error ? ' is-error' : '');
      bubble.innerHTML = opts.pending ? '<span class="assistant-dots"><i></i><i></i><i></i></span>' : formatAssistantText(text);
      container.appendChild(bubble);
      container.scrollTop = container.scrollHeight;
      return bubble;
    }

    function resetAssistant() {
      _assistantHistory = [];
      _assistantBusy = false;
      var container = byId('assistant-messages');
      if (container) {
        container.innerHTML = '<div class="assistant-hint">基于本篇文字稿提问，例如「这期的核心观点是什么？」「嘉宾举了哪些案例？」<br>选中正文里的词，还能一键查百科。</div>';
      }
      var question = byId('assistant-question');
      if (question) question.value = '';
    }

    function openAssistantPanel() {
      if (!_assistantAvailable) return;
      byId('reader-assistant').hidden = false;
      document.querySelector('.reader-layout').classList.add('assistant-open');
      var toggle = byId('assistant-toggle-btn');
      toggle.classList.add('active');
      toggle.setAttribute('aria-pressed', 'true');
      var question = byId('assistant-question');
      if (question) setTimeout(function () { question.focus(); }, 60);
    }

    function closeAssistantPanel() {
      var panel = byId('reader-assistant');
      if (panel) panel.hidden = true;
      var layout = document.querySelector('.reader-layout');
      if (layout) layout.classList.remove('assistant-open');
      var toggle = byId('assistant-toggle-btn');
      if (toggle) { toggle.classList.remove('active'); toggle.setAttribute('aria-pressed', 'false'); }
    }

    function toggleAssistantPanel() {
      if (byId('reader-assistant').hidden) openAssistantPanel();
      else closeAssistantPanel();
    }

    function sendAssistantQuestion() {
      if (_assistantBusy) return;
      var input = byId('assistant-question');
      var question = String(input.value || '').trim();
      if (!question) return;
      if (!_currentReadingTaskId) { addLog('请先打开一篇稿件', 'error'); return; }
      input.value = '';
      _assistantBusy = true;
      byId('assistant-send-btn').disabled = true;
      appendAssistantMessage('user', question);
      var pending = appendAssistantMessage('assistant', '', { pending: true });

      fetch(safeTaskUrl(_currentReadingTaskId, '/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question, history: _assistantHistory.slice(-8) })
      })
        .then(function (response) {
          return response.text().then(function (raw) {
            if (!response.ok) { var detail = raw; try { detail = JSON.parse(raw).detail || detail; } catch (ignore) {} throw new Error(detail || 'HTTP ' + response.status); }
            return JSON.parse(raw);
          });
        })
        .then(function (data) {
          var answer = String(data.answer || '');
          pending.classList.remove('is-pending');
          pending.innerHTML = formatAssistantText(answer);
          if (data.context_truncated) {
            var note = document.createElement('div');
            note.className = 'assistant-note';
            note.textContent = '（稿件较长，回答基于文字稿前一部分）';
            pending.appendChild(note);
          }
          _assistantHistory.push({ role: 'user', content: question });
          _assistantHistory.push({ role: 'assistant', content: answer });
          byId('assistant-messages').scrollTop = byId('assistant-messages').scrollHeight;
        })
        .catch(function (error) {
          pending.classList.remove('is-pending');
          pending.classList.add('is-error');
          pending.textContent = '助手出错了：' + errorMessage(error);
        })
        .finally(function () {
          _assistantBusy = false;
          byId('assistant-send-btn').disabled = false;
        });
    }

    // ── 划词百科查询 ──
    function hideLookupPopover() { var el = byId('lookup-popover'); if (el) el.hidden = true; }
    function hideLookupCard() { var el = byId('lookup-card'); if (el) el.hidden = true; }

    function onManuscriptSelection() {
      if (!_assistantAvailable) return;
      var selection = window.getSelection();
      var term = selection ? String(selection.toString()).trim() : '';
      var body = byId('manuscript-body');
      if (!term || term.length > 60 || !selection.rangeCount) { hideLookupPopover(); return; }
      var range = selection.getRangeAt(0);
      if (!body.contains(range.commonAncestorContainer)) { hideLookupPopover(); return; }
      _lookupTerm = term;
      var block = range.startContainer.parentElement ? range.startContainer.parentElement.closest('p, li, h1, h2, h3, blockquote') : null;
      _lookupContext = block ? String(block.textContent || '').trim().slice(0, 600) : '';
      byId('lookup-term-label').textContent = term.length > 12 ? term.slice(0, 12) + '…' : term;
      var rect = range.getBoundingClientRect();
      var popover = byId('lookup-popover');
      popover.hidden = false;
      var top = rect.top - popover.offsetHeight - 8;
      if (top < 8) top = rect.bottom + 8;
      var left = rect.left + rect.width / 2 - popover.offsetWidth / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - popover.offsetWidth - 8));
      popover.style.top = top + 'px';
      popover.style.left = left + 'px';
    }

    function runLookup() {
      var term = _lookupTerm;
      if (!term) return;
      hideLookupPopover();
      var card = byId('lookup-card');
      byId('lookup-card-term').textContent = term;
      byId('lookup-card-body').innerHTML = '<span class="assistant-dots"><i></i><i></i><i></i></span>';
      card.hidden = false;

      fetch(appUrl('/api/read-podcast/assistant/lookup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term: term, context: _lookupContext })
      })
        .then(function (response) {
          return response.text().then(function (raw) {
            if (!response.ok) { var detail = raw; try { detail = JSON.parse(raw).detail || detail; } catch (ignore) {} throw new Error(detail || 'HTTP ' + response.status); }
            return JSON.parse(raw);
          });
        })
        .then(function (data) { byId('lookup-card-body').innerHTML = formatAssistantText(String(data.explanation || '暂无解释')); })
        .catch(function (error) { byId('lookup-card-body').innerHTML = '<span class="lookup-error">查询失败：' + escapeHtml(errorMessage(error)) + '</span>'; });
    }

    // ── 跨节目提问（稿件库） ──
    var _libraryHistory = [];
    var _libraryBusy = false;

    function renderLibrarySources(bubble, sources) {
      if (!sources || !sources.length) return;
      var wrap = document.createElement('div');
      wrap.className = 'assistant-sources';
      var label = document.createElement('span');
      label.className = 'assistant-sources-label';
      label.textContent = '来源：';
      wrap.appendChild(label);
      sources.forEach(function (src) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'source-chip';
        chip.textContent = '【' + src.index + '】' + String(src.title || '未命名');
        chip.title = '打开这篇稿件';
        chip.addEventListener('click', function () { openManuscript(src.task_id); });
        wrap.appendChild(chip);
      });
      bubble.appendChild(wrap);
    }

    function sendLibraryQuestion() {
      if (_libraryBusy) return;
      var input = byId('library-ask-question');
      var question = String(input.value || '').trim();
      if (!question) return;
      input.value = '';
      _libraryBusy = true;
      byId('library-ask-send').disabled = true;
      var container = byId('library-ask-messages');
      appendAssistantMessage('user', question, { container: container });
      var pending = appendAssistantMessage('assistant', '', { container: container, pending: true });

      fetch(appUrl('/api/read-podcast/assistant/library/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question, history: _libraryHistory.slice(-8) })
      })
        .then(function (response) {
          return response.text().then(function (raw) {
            if (!response.ok) { var detail = raw; try { detail = JSON.parse(raw).detail || detail; } catch (ignore) {} throw new Error(detail || 'HTTP ' + response.status); }
            return JSON.parse(raw);
          });
        })
        .then(function (data) {
          var answer = String(data.answer || '');
          pending.classList.remove('is-pending');
          pending.innerHTML = formatAssistantText(answer);
          renderLibrarySources(pending, data.sources);
          if (data.context_truncated) {
            var note = document.createElement('div');
            note.className = 'assistant-note';
            note.textContent = '（稿件较多，回答基于最相关的部分节目）';
            pending.appendChild(note);
          }
          _libraryHistory.push({ role: 'user', content: question });
          _libraryHistory.push({ role: 'assistant', content: answer });
          container.scrollTop = container.scrollHeight;
        })
        .catch(function (error) {
          pending.classList.remove('is-pending');
          pending.classList.add('is-error');
          pending.textContent = '提问出错了：' + errorMessage(error);
        })
        .finally(function () {
          _libraryBusy = false;
          byId('library-ask-send').disabled = false;
        });
    }

    function refreshAssistantAvailability() {
      return fetch(appUrl('/api/read-podcast/assistant/status'))
        .then(function (r) { return r.ok ? r.json() : { available: false }; })
        .then(function (data) {
          _assistantAvailable = !!(data && data.available);
          setHidden(byId('assistant-toggle-btn'), !_assistantAvailable);
          setHidden(byId('library-ask'), !_assistantAvailable);
        })
        .catch(function () { _assistantAvailable = false; });
    }

    function initAssistant() {
      refreshAssistantAvailability();

      byId('library-ask-form').addEventListener('submit', function (event) { event.preventDefault(); sendLibraryQuestion(); });

      byId('assistant-toggle-btn').addEventListener('click', toggleAssistantPanel);
      byId('assistant-close-btn').addEventListener('click', closeAssistantPanel);
      byId('assistant-form').addEventListener('submit', function (event) { event.preventDefault(); sendAssistantQuestion(); });
      byId('assistant-question').addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendAssistantQuestion(); }
      });
      byId('lookup-trigger').addEventListener('click', runLookup);
      byId('lookup-card-close').addEventListener('click', hideLookupCard);
      byId('manuscript-body').addEventListener('mouseup', function () { setTimeout(onManuscriptSelection, 10); });
      byId('manuscript-body').addEventListener('scroll', function () { hideLookupPopover(); });
      document.addEventListener('mousedown', function (event) {
        if (!byId('lookup-popover').contains(event.target)) hideLookupPopover();
        var card = byId('lookup-card');
        if (!card.hidden && !card.contains(event.target)) hideLookupCard();
      });
    }

