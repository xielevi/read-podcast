    function renderConceptsSection(taskId, container) {

      var section = document.createElement('div');
      section.className = 'concepts-section';

      var title = document.createElement('h3');
      title.textContent = t('concepts.title');
      section.appendChild(title);

      var body = document.createElement('div');
      body.className = 'concepts-body';
      section.appendChild(body);

      container.appendChild(section);
      loadConcepts(taskId, body);
    }

    // 公开浏览没有可展示的概念时不留空壳：移除整个区块，侧栏空了就一并收起。
    function removeConceptsSection(body) {
      var section = body.closest('.concepts-section');
      var sidebar = section && section.parentElement;
      if (section) section.remove();
      if (sidebar && !sidebar.children.length) setHidden(sidebar, true);
    }

    function loadConcepts(taskId, body) {
      body.replaceChildren();
      var loading = document.createElement('div');
      loading.className = 'concepts-empty';
      loading.textContent = IS_MANAGE ? t('concepts.extracting') : t('concepts.reading');
      body.appendChild(loading);

      // 控制模式按需抽取（会调用模型并写缓存）；公开浏览只读取已缓存的结果。
      var lang = getLocale() === 'en' ? 'en' : 'zh';
      var suffix = lang === 'en' ? '/concepts?lang=en' : '/concepts';
      var request = IS_MANAGE
        ? fetch(safeTaskUrl(taskId, suffix), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
        : fetch(articleUrl(taskId, suffix));
      request
        .then(function (response) {
          return response.text().then(function (raw) {
            if (!response.ok) {
              var detail = raw;
              try { detail = JSON.parse(raw).detail || detail; } catch (ignore) {}
              throw new Error(detail || 'HTTP ' + response.status);
            }
            return JSON.parse(raw);
          });
        })
        .then(function (data) {
          var concepts = (data && data.concepts) || [];
          body.replaceChildren();
          if (!concepts.length && !IS_MANAGE) {
            removeConceptsSection(body);
            return;
          }
          if (!concepts.length) {
            var empty = document.createElement('div');
            empty.className = 'concepts-empty';
            empty.textContent = t('concepts.empty');
            body.appendChild(empty);
            return;
          }
          var list = document.createElement('ul');
          list.className = 'concepts-list';
          concepts.forEach(function (concept) {
            var li = document.createElement('li');

            var link = document.createElement('a');
            link.className = 'concept-link';
            link.href = String(concept.url || '');
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = String(concept.term || '');
            // 词条标题与提名词不同时（重定向/异语言）标出来，避免读者以为点错了。
            var resolved = String(concept.wikipedia_title || '');
            if (resolved && resolved !== String(concept.term || '')) {
              var alias = document.createElement('span');
              alias.className = 'concept-alias';
              alias.textContent = '· ' + resolved;
              link.appendChild(alias);
            }
            li.appendChild(link);

            var summary = String(concept.summary || '');
            if (summary) {
              var desc = document.createElement('div');
              desc.className = 'concept-summary';
              desc.textContent = summary;
              li.appendChild(desc);
            }
            list.appendChild(li);
          });
          body.appendChild(list);

          linkifyManuscriptConcepts(concepts);
        })
        .catch(function (error) {
          body.replaceChildren();
          if (!IS_MANAGE) {
            removeConceptsSection(body);
            return;
          }
          var failed = document.createElement('div');
          failed.className = 'concepts-empty';
          failed.textContent = t('concepts.failed') + errorMessage(error);
          body.appendChild(failed);
          var retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'concepts-load-btn';
          retry.textContent = t('concepts.retry');
          retry.addEventListener('click', function () { loadConcepts(taskId, body); });
          body.appendChild(retry);
        });
    }

    // 把已核对的关键概念在正文里原地变成可点的维基百科链接：每个概念只链接
    // 第一次出现（避免满屏都是下划线），按词长降序处理，防止短词（如「AI」）
    // 抢在长词（如「OpenAI」）前面把它从中间截断。
    function linkifyManuscriptConcepts(concepts) {
      var root = byId('manuscript-body');
      if (!root) return;
      (concepts || [])
        .map(function (c) { return { term: String(c.term || '').trim(), url: String(c.url || '').trim() }; })
        .filter(function (c) { return c.term && c.url; })
        .sort(function (a, b) { return b.term.length - a.term.length; })
        .forEach(function (c) { linkifyFirstOccurrence(root, c.term, c.url); });
    }

    function isAsciiAlnum(ch) {
      return !!ch && /[A-Za-z0-9]/.test(ch);
    }

    // 只在词边界处匹配：纯子串查找会把「OpenAI」里的「AI」错误地单独截出来。
    function findTermStart(text, term) {
      var from = 0;
      while (true) {
        var idx = text.indexOf(term, from);
        if (idx === -1) return -1;
        var before = idx > 0 ? text[idx - 1] : '';
        var after = idx + term.length < text.length ? text[idx + term.length] : '';
        var okBefore = !isAsciiAlnum(term[0]) || !isAsciiAlnum(before);
        var okAfter = !isAsciiAlnum(term[term.length - 1]) || !isAsciiAlnum(after);
        if (okBefore && okAfter) return idx;
        from = idx + 1;
      }
    }

    function linkifyFirstOccurrence(root, term, url) {
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          if (!node.nodeValue || findTermStart(node.nodeValue, term) === -1) return NodeFilter.FILTER_SKIP;
          if (node.parentElement && node.parentElement.closest('a')) return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var node = walker.nextNode();
      if (!node) return;
      var idx = findTermStart(node.nodeValue, term);
      var match = node.splitText(idx);
      match.splitText(term.length);
      var link = document.createElement('a');
      link.className = 'concept-inline-link';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = t('concepts.wiki_title');
      link.textContent = match.nodeValue;
      match.parentNode.replaceChild(link, match);
    }

    function closeManuscript() {
      _currentReadingTaskId = null;
      _currentReadingRef = null;
      updateReaderReadState();
      if (_tocObserver) {
        _tocObserver.disconnect();
        _tocObserver = null;
      }
      closeReaderSheets();
      byId('manuscript-reader').classList.remove('is-open'); 
      byId('reader-overlay').classList.remove('is-open'); 
      byId('manuscript-reader').setAttribute('aria-hidden', 'true'); 
      document.body.classList.remove('overlay-open');
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, _savedScrollY);
    }

    byId('tab-podcast').addEventListener('click', function () { switchMode('podcast'); });
    byId('tab-custom').addEventListener('click', function () { switchMode('custom'); });
    byId('tab-library').addEventListener('click', function () { switchMode('library'); });
    byId('prompt-template-select').addEventListener('change', function () { applyPromptTemplate(this.value); });
    byId('custom-submit-btn').addEventListener('click', submitCustomTask);
    byId('episode-search').addEventListener('input', onEpisodeSearch);
    byId('library-search').addEventListener('input', function () { renderLibrary(_libraryArticles); });
    document.querySelectorAll('[data-library-filter]').forEach(function (button) {
      button.addEventListener('click', function () {
        _libraryFilter = button.dataset.libraryFilter || 'all';
        document.querySelectorAll('[data-library-filter]').forEach(function (item) { item.classList.toggle('active', item === button); });
        renderLibrary(_libraryArticles);
      });
    });
    document.querySelectorAll('.mobile-nav [data-mode]').forEach(function (button) { button.addEventListener('click', function () { switchMode(button.dataset.mode); }); });
    function setTaskPanel(open) {
      byId('task-panel').classList.toggle('is-open', open);
      byId('task-panel-overlay').classList.toggle('is-open', open);
      byId('task-panel').setAttribute('aria-hidden', String(!open));
      document.body.classList.toggle('overlay-open', open);
    }
    byId('task-panel-btn').addEventListener('click', function () { setTaskPanel(true); });
    byId('task-panel-close').addEventListener('click', function () { setTaskPanel(false); });
    byId('task-panel-overlay').addEventListener('click', function () { setTaskPanel(false); });
    byId('filter-all').addEventListener('click', function () { setFilter('all'); });
    byId('filter-readable').addEventListener('click', function () { setFilter('readable'); });
    byId('filter-unread').addEventListener('click', function () { setFilter('unread'); });
    byId('filter-read').addEventListener('click', function () { setFilter('read'); });
    byId('page-prev').addEventListener('click', function () { goToEpisodePage(currentPage - 1); });
    byId('page-next').addEventListener('click', function () { goToEpisodePage(currentPage + 1); });
    
    // Font controls
    byId('font-dec-btn').addEventListener('click', function () { setFontSize(_currentFontSize - 1); });
    byId('font-inc-btn').addEventListener('click', function () { setFontSize(_currentFontSize + 1); });
    byId('font-preset-classical').addEventListener('click', function () { setFontPreset('classical'); });
    byId('font-preset-modern').addEventListener('click', function () { setFontPreset('modern'); });
    
    // Theme controls
    byId('theme-follow-btn').addEventListener('click', function () { setTheme('follow'); });
    byId('theme-light-btn').addEventListener('click', function () { setTheme('paper'); });
    byId('theme-warm-btn').addEventListener('click', function () { setTheme('warm'); });
    byId('theme-green-btn').addEventListener('click', function () { setTheme('green'); });
    byId('theme-dark-btn').addEventListener('click', function () { setTheme('dark'); });

    // Leading controls
    byId('leading-compact-btn').addEventListener('click', function () { setLineHeight('compact'); });
    byId('leading-normal-btn').addEventListener('click', function () { setLineHeight('normal'); });
    byId('leading-relaxed-btn').addEventListener('click', function () { setLineHeight('relaxed'); });

    // Reader TOC toggle
    byId('reader-toc-toggle-btn').addEventListener('click', function () {
      var toc = byId('reader-toc');
      if (window.innerWidth <= 780) {
        var isOpen = toc.classList.toggle('is-open');
        byId('reader-sheet-backdrop').classList.toggle('is-open', isOpen);
      } else {
        var isHidden = toc.hasAttribute('hidden');
        setHidden(toc, !isHidden);
        this.classList.toggle('active', isHidden);
      }
    });

    // 移动端标题常态最多两行，点按展开/收起完整标题（桌面无截断，切换无副作用）
    byId('reader-title').addEventListener('click', function () {
      this.classList.toggle('reader-title-expanded');
    });

    // Mobile bottom bar
    byId('reader-bar-toc-btn').addEventListener('click', function () {
      var toc = byId('reader-toc');
      var willOpen = !toc.classList.contains('is-open');
      closeReaderSheets();
      if (willOpen) {
        toc.classList.add('is-open');
        byId('reader-sheet-backdrop').classList.add('is-open');
        this.classList.add('active');
      }
    });
    byId('reader-bar-progress-btn').addEventListener('click', function () {
      var sheet = byId('reader-progress-sheet');
      var willOpen = !sheet.classList.contains('is-open');
      closeReaderSheets();
      if (willOpen) {
        sheet.classList.add('is-open');
        byId('reader-sheet-backdrop').classList.add('is-open');
        this.classList.add('active');
      }
    });
    byId('reader-bar-appearance-btn').addEventListener('click', function () {
      var menu = byId('reader-appearance-menu');
      var willOpen = !menu.hasAttribute('open');
      closeReaderSheets();
      if (willOpen) {
        menu.setAttribute('open', '');
        byId('reader-sheet-backdrop').classList.add('is-open');
        this.classList.add('active');
      }
    });

    // Mobile sheet controls
    byId('reader-sheet-backdrop').addEventListener('click', closeReaderSheets);
    byId('reader-progress-sheet-close').addEventListener('click', closeReaderSheets);
    byId('reader-sheet-progress-range').addEventListener('input', function () {
      var body = byId('manuscript-body');
      var totalScroll = Math.max(0, body.scrollHeight - body.clientHeight);
      var percent = Math.min(100, Math.max(0, Number(this.value) || 0));
      body.scrollTop = totalScroll * percent / 100;
      updateReaderProgress(percent);
    });
    byId('reader-jump-start-btn').addEventListener('click', function () {
      byId('manuscript-body').scrollTop = 0;
      updateReaderProgress(0);
    });
    byId('reader-jump-end-btn').addEventListener('click', function () {
      var body = byId('manuscript-body');
      body.scrollTop = Math.max(0, body.scrollHeight - body.clientHeight);
      updateReaderProgress(100);
    });

    // 滚动热路径：用单个 requestAnimationFrame 每帧合并一次视觉更新，
    // 并缓存静态 DOM 引用（.reader-sheet 不随滚动变化）；帧内先读布局再写样式，
    // 避免写后读造成强制重排。持久化（控制模式）保持独立的 150ms 节流，语义不变。
    var _readerSheetEl = document.querySelector('.reader-sheet');
    var _readerScrollFrame = 0;
    var _scrollThrottleTimer = null;
    byId('manuscript-body').addEventListener('scroll', function () {
      var self = this;
      if (_readerScrollFrame) return;
      _readerScrollFrame = requestAnimationFrame(function () {
        _readerScrollFrame = 0;
        var top = self.scrollTop;
        var delta = top - _lastReaderScrollTop;
        if (top <= 12 || delta < -8) _readerSheetEl.classList.remove('reader-head-collapsed');
        else if (delta > 8 && top > 56) _readerSheetEl.classList.add('reader-head-collapsed');
        _lastReaderScrollTop = top;

        var totalScroll = self.scrollHeight - self.clientHeight;
        var percent = totalScroll > 0 ? (top / totalScroll * 100) : (self.scrollHeight > 0 ? 100 : 0);
        updateReaderProgress(percent);

        if (!_currentReadingTaskId || !IS_MANAGE) return;
        if (_scrollThrottleTimer) return;
        _scrollThrottleTimer = setTimeout(function () {
          localStorage.setItem('scroll_pos_' + _currentReadingTaskId, self.scrollTop);
          _scrollThrottleTimer = null;
        }, 150);
      });
    });
    byId('reader-progress-range').addEventListener('input', function () {
      var body = byId('manuscript-body');
      var totalScroll = Math.max(0, body.scrollHeight - body.clientHeight);
      var percent = Math.min(100, Math.max(0, Number(this.value) || 0));
      body.scrollTop = totalScroll * percent / 100;
      updateReaderProgress(percent);
    });
    byId('reader-read-toggle').addEventListener('click', function () {
      if (_currentReadingRef) setRead(_currentReadingRef, !isRead(_currentReadingRef));
    });
    byId('episode-summary-close-btn').addEventListener('click', closeEpisodeSummary);
    byId('episode-summary-overlay').addEventListener('click', closeEpisodeSummary);
    byId('refresh-btn').addEventListener('click', function () {
      // 强制刷新会拉 RSS 并写 D1，属于控制模式。
      if (!requireControl('refresh', selectedPodcast ? { podcast: selectedPodcast } : null)) return;
      loadTimelineEpisodes(getScopedSubscriptions(), true);
    });
    byId('add-podcast-btn').addEventListener('click', openDrawer);
    byId('drawer-close-btn').addEventListener('click', closeDrawer);
    byId('drawer-overlay').addEventListener('click', closeDrawer);
    byId('drawer-search').addEventListener('input', function () { onDrawerSearch(this.value); });
    byId('reader-close-btn').addEventListener('click', closeManuscript);
    byId('reader-overlay').addEventListener('click', closeManuscript);
    // 选择文件之前就进入 Access：公开浏览不打开文件选择器，也不发起任何上传请求。
    function chooseAudioFile() { if (requireControl('import')) byId('audio-file-input').click(); }
    byId('upload-drop-zone').addEventListener('click', chooseAudioFile);
    byId('upload-drop-zone').addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseAudioFile(); } });
    byId('upload-drop-zone').addEventListener('dragover', function (event) { event.preventDefault(); this.classList.add('is-dragging'); });
    byId('upload-drop-zone').addEventListener('dragleave', function () { this.classList.remove('is-dragging'); });
    byId('upload-drop-zone').addEventListener('drop', handleAudioDrop);
    byId('audio-file-input').addEventListener('change', function () { handleAudioFileChange(this); });
    function trapOverlayFocus(event, container) {
      if (event.key !== 'Tab' || !container || !container.classList.contains('is-open')) return;
      var focusable = container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      var first = focusable[0]; var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', function (event) {
      trapOverlayFocus(event, byId('drawer'));
      trapOverlayFocus(event, byId('manuscript-reader'));
      trapOverlayFocus(event, byId('settings-drawer'));
      if (event.key !== 'Escape') return;
      var toc = byId('reader-toc');
      var sheet = byId('reader-progress-sheet');
      var menu = byId('reader-appearance-menu');
      if ((toc && toc.classList.contains('is-open')) || (sheet && sheet.classList.contains('is-open')) || (menu && menu.hasAttribute('open'))) {
        closeReaderSheets();
      }
      else if (byId('manuscript-reader').classList.contains('is-open')) closeManuscript();
      else if (byId('settings-drawer').classList.contains('is-open')) closeSettings();
      else if (byId('drawer').classList.contains('is-open')) closeDrawer();
      else if (byId('task-panel').classList.contains('is-open')) setTaskPanel(false);
      else if (byId('episode-summary-drawer').classList.contains('is-open')) closeEpisodeSummary();
    });

    function reloadReaderConcepts() {
      if (!_currentReadingTaskId) return;
      var tocContainer = byId('reader-toc');
      if (!tocContainer) return;
      var existingSection = tocContainer.querySelector('.concepts-section');
      if (existingSection) existingSection.remove();
      var root = byId('manuscript-body');
      if (root) {
        var inlineLinks = root.querySelectorAll('a.concept-inline-link');
        inlineLinks.forEach(function (link) {
          var textNode = document.createTextNode(link.textContent);
          link.parentNode.replaceChild(textNode, link);
        });
        root.normalize();
      }
      renderConceptsSection(_currentReadingTaskId, tocContainer);
      setHidden(tocContainer, false);
    }

    byId('lang-toggle-btn').addEventListener('click', toggleLocale);
    byId('reader-lang-toggle-btn').addEventListener('click', toggleLocale);

    // 两种模式进入同一个工作区。
    switchMode('podcast');

