    function updateReaderStats(rawText) {
      var cleanText = String(rawText || '').replace(/^\s*---\s*\n[\s\S]*?\n---\s*\n*/, '').replace(/\s+/g, '');
      var count = cleanText.length;
      var minutes = Math.max(1, Math.round(count / 750));
      var countStr = count >= 10000 ? (count / 10000).toFixed(1) + ' 万字' : count + ' 字';
      var statsEl = byId('reader-meta-stats');
      if (statsEl) {
        statsEl.textContent = count ? (countStr + ' · 预计阅读 ' + minutes + ' 分钟') : '';
      }
    }

    function updateReaderProgress(percent) {
      var bounded = Math.min(100, Math.max(0, Number(percent) || 0));
      var progressRange = byId('reader-progress-range');
      var progressValue = byId('reader-progress-value');
      if (progressRange) progressRange.value = String(bounded);
      if (progressValue) progressValue.textContent = Math.round(bounded) + '%';
      if (bounded >= 99.5 && _currentReadingEpisode && !isEpisodeRead(_currentReadingEpisode)) {
        setEpisodeRead(_currentReadingEpisode, true);
      }
    }

    function setupTocScrollSpy(headings, tocLinks) {
      if (_tocObserver) {
        _tocObserver.disconnect();
        _tocObserver = null;
      }
      if (!('IntersectionObserver' in window) || !headings.length) return;

      _tocObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            var id = entry.target.id;
            tocLinks.forEach(function (link) {
              var isMatch = link.getAttribute('data-target-id') === id;
              link.classList.toggle('active', isMatch);
              if (isMatch) {
                link.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              }
            });
          }
        });
      }, {
        root: byId('manuscript-body'),
        rootMargin: '-5% 0px -75% 0px',
        threshold: 0
      });

      headings.forEach(function (heading) {
        _tocObserver.observe(heading);
      });
    }

    function renderBasicMarkdown(markdown) {
      if (markdown == null) return '';
      var raw = String(markdown).replace(/\r\n?/g, '\n');
      raw = raw.replace(/^\s*---\s*\n[\s\S]*?\n---\s*\n*/, '');
      var codeBlocks = [];
      raw = raw.replace(/```(\w*)\n([\s\S]*?)```/g, function (match, lang, code) {
        var placeholder = '<!--CODEBLOCK' + codeBlocks.length + '-->';
        codeBlocks.push({ lang: lang, code: code });
        return placeholder;
      });
      var lines = raw.split('\n');
      var html = [];
      var paragraph = [];
      var listType = null;
      function flushParagraph() {
        if (paragraph.length) {
          var text = paragraph.join('\n');
          text = parseInline(text);
          html.push('<p>' + text + '</p>');
          paragraph = [];
        }
      }
      function closeList() {
        if (listType) {
          html.push('</' + listType + '>');
          listType = null;
        }
      }
      function parseInline(text) {
        var escaped = escapeHtml(text);
        escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        escaped = escaped.replace(/__([^_]+)__/g, '<strong>$1</strong>');
        escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        escaped = escaped.replace(/_([^_]+)_/g, '<em>$1</em>');
        escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
        var SAFE_LINK = /^(?:https?:|mailto:|#|\/)/i;
        escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (match, text, url) {
          var target = url.trim();
          return SAFE_LINK.test(target)
            ? '<a href="' + target + '" target="_blank" rel="noopener">' + text + '</a>'
            : text;
        });
        // 说话人 Pill Badge 微勋章美化转换
        escaped = escaped.replace(/<strong>([^<]+)<\/strong>(\s*[:：])/g, '<span class="speaker-tag">$1</span>$2');
        escaped = escaped.replace(/\n/g, '<br>');
        return escaped;
      }
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var trimmed = line.trim();
        if (trimmed.indexOf('<!--CODEBLOCK') === 0 && trimmed.indexOf('-->') > 0) {
          flushParagraph();
          closeList();
          var idx = parseInt(trimmed.match(/\d+/)[0], 10);
          var block = codeBlocks[idx];
          if (!block) {
            paragraph.push(line);
            continue;
          }
          html.push('<pre><code class="language-' + escapeHtml(block.lang) + '">' + escapeHtml(block.code) + '</code></pre>');
          continue;
        }
        var heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
          flushParagraph();
          closeList();
          var level = heading[1].length;
          html.push('<h' + level + '>' + parseInline(heading[2]) + '</h' + level + '>');
          continue;
        }
        var hr = /^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})\s*$/.test(line);
        if (hr) {
          flushParagraph();
          closeList();
          html.push('<hr>');
          continue;
        }
        var quote = line.match(/^\s*>\s?(.*)$/);
        if (quote) {
          flushParagraph();
          closeList();
          html.push('<blockquote>' + parseInline(quote[1]) + '</blockquote>');
          continue;
        }
        var unordered = line.match(/^\s*[-*+]\s+(.+)$/);
        var ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
        if (unordered || ordered) {
          flushParagraph();
          var requiredType = unordered ? 'ul' : 'ol';
          if (listType !== requiredType) {
            closeList();
            listType = requiredType;
            html.push('<' + listType + '>');
          }
          if (unordered) {
            html.push('<li>' + parseInline(unordered[1]) + '</li>');
          } else {
            html.push('<li value="' + ordered[1] + '">' + parseInline(ordered[2]) + '</li>');
          }
          continue;
        }
        if (!trimmed) {
          flushParagraph();
          closeList();
          continue;
        }
        closeList();
        paragraph.push(line);
      }
      flushParagraph();
      closeList();
      var finalHtml = html.join('\n');
      for (var k = 0; k < codeBlocks.length; k++) {
        var placeholderPattern = new RegExp('<!--CODEBLOCK' + k + '-->', 'g');
        finalHtml = finalHtml.replace(placeholderPattern, '<pre><code class="language-' + escapeHtml(codeBlocks[k].lang) + '">' + escapeHtml(codeBlocks[k].code) + '</code></pre>');
      }
      return finalHtml;
    }

    function setFontSize(size) {
      _currentFontSize = Math.max(14, Math.min(28, size));
      byId('manuscript-body').style.fontSize = _currentFontSize + 'px';
      localStorage.setItem('reader_font_size', _currentFontSize);
    }

    function setTheme(theme) {
      _currentTheme = theme;
      var normalizedTheme = theme === 'light' ? 'paper' : theme;
      document.documentElement.dataset.theme = normalizedTheme;
      var colorScheme = document.querySelector('meta[name="color-scheme"]');
      if (colorScheme) colorScheme.setAttribute('content', theme === 'dark' ? 'dark' : 'light');
      var sheet = document.querySelector('.reader-sheet');
      if (sheet) {
        sheet.classList.remove('theme-green', 'theme-dark');
        if (theme === 'green') {
          sheet.classList.add('theme-green');
        } else if (theme === 'dark') {
          sheet.classList.add('theme-dark');
        }
      }
      localStorage.setItem('reader_theme', theme);
    }

    function restoreScroll(element, targetScrollTop, retries) {
      if (retries <= 0) return;
      element.scrollTop = targetScrollTop;
      if (Math.abs(element.scrollTop - targetScrollTop) > 2) {
        setTimeout(function() {
          restoreScroll(element, targetScrollTop, retries - 1);
        }, 50);
      }
    }

    function openManuscript(taskId, episode) {
      var cleanId = String(taskId || '').trim();
      if (!cleanId) return;
      closeEpisodeSummary();
      _currentReadingTaskId = cleanId;
      resetAssistant();
      var task = _taskHistory.find(function (item) { return String(item.id) === cleanId; });
      _currentReadingEpisode = episode || (task ? { podcast_name: task.podcast_name, title: task.episode_title } : null);
      byId('reader-title').textContent = task && task.episode_title ? String(task.episode_title) : '阅读';
      byId('reader-download').href = safeTaskUrl(cleanId, '/download');
      updateReaderReadState();
      
      var tocContainer = byId('reader-toc');
      setHidden(tocContainer, true);
      tocContainer.replaceChildren();
      byId('manuscript-body').innerHTML = '<div class="reader-state reader-loading">正在展开稿纸</div>';
      
      var progressRange = byId('reader-progress-range');
      var progressValue = byId('reader-progress-value');
      if (progressRange) progressRange.value = '0';
      if (progressValue) progressValue.textContent = '0%';
      _lastReaderScrollTop = 0;
      document.querySelector('.reader-sheet').classList.remove('reader-head-collapsed');
      
      _savedScrollY = window.scrollY;
      document.body.style.position = 'fixed';
      document.body.style.top = '-' + _savedScrollY + 'px';
      document.body.style.width = '100%';
      
      byId('manuscript-reader').classList.add('is-open'); 
      byId('reader-overlay').classList.add('is-open'); 
      byId('manuscript-reader').setAttribute('aria-hidden', 'false'); 
      document.body.classList.add('overlay-open');
      
      var savedFontSize = localStorage.getItem('reader_font_size');
      setFontSize(savedFontSize ? parseInt(savedFontSize, 10) : 19);
      var savedTheme = localStorage.getItem('reader_theme');
      setTheme(savedTheme || 'light');

      fetch(safeTaskUrl(cleanId, '/content'))
        .then(function (response) {
          return response.text().then(function (raw) {
            if (!response.ok) { var detail = raw; try { detail = JSON.parse(raw).detail || detail; } catch (ignore) {} throw new Error(detail || 'HTTP ' + response.status); }
            var contentType = response.headers.get('content-type') || '';
            if (contentType.indexOf('application/json') >= 0) {
              var data = JSON.parse(raw);
              return { content: data.content || data.markdown || data.text || '', title: data.title || '' };
            }
            return { content: raw, title: '' };
          });
        })
        .then(function (result) {
          if (result.title) byId('reader-title').textContent = String(result.title);
          if (!result.content) { 
            byId('manuscript-body').innerHTML = '<div class="reader-state">稿件内容为空。</div>'; 
            updateReaderStats('');
            return; 
          }
          
          updateReaderStats(result.content);
          var renderedHtml = renderBasicMarkdown(result.content);
          byId('manuscript-body').innerHTML = renderedHtml;
          
          var headings = byId('manuscript-body').querySelectorAll('h1, h2, h3');
          var tocLinks = [];
          if (headings.length > 0) {
            var tocTitle = document.createElement('h3');
            tocTitle.textContent = '大纲目录';
            tocContainer.appendChild(tocTitle);
            
            var tocList = document.createElement('ul');
            tocList.className = 'toc-list';
            
            headings.forEach(function (heading, idx) {
              var id = 'heading-' + idx;
              heading.id = id;
              
              var li = document.createElement('li');
              var a = document.createElement('a');
              a.className = 'toc-item level-' + heading.tagName.substring(1);
              a.textContent = heading.textContent;
              a.setAttribute('data-target-id', id);
              a.addEventListener('click', function () {
                heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
              });
              tocLinks.push(a);
              li.appendChild(a);
              tocList.appendChild(li);
            });
            tocContainer.appendChild(tocList);
            setupTocScrollSpy(headings, tocLinks);
          }
          // 侧栏同时承载大纲与关键概念，任一存在就展开。
          renderConceptsSection(cleanId, tocContainer);
          setHidden(tocContainer, headings.length === 0 && !_assistantAvailable);

          var saved = localStorage.getItem('scroll_pos_' + cleanId);
          if (saved) {
            var savedTop = parseInt(saved, 10) || 0;
            restoreScroll(byId('manuscript-body'), savedTop, 10);
            var savedTotal = Math.max(0, byId('manuscript-body').scrollHeight - byId('manuscript-body').clientHeight);
            updateReaderProgress(savedTotal > 0 ? savedTop / savedTotal * 100 : 100);
          } else {
            byId('manuscript-body').scrollTop = 0;
            var initialTotal = Math.max(0, byId('manuscript-body').scrollHeight - byId('manuscript-body').clientHeight);
            updateReaderProgress(initialTotal > 0 ? 0 : 100);
          }
        })
        .catch(function (error) { 
          byId('manuscript-body').replaceChildren(); 
          var state = document.createElement('div'); 
          state.className = 'reader-state'; 
          state.textContent = '稿件读取失败：' + errorMessage(error); 
          byId('manuscript-body').appendChild(state); 
          updateReaderStats('');
        });
    }

    // ── 关键概念 → 维基百科 ────────────────────────────────
    // 打开稿件即自动抽取一次（结果由后端按稿件缓存，重复打开不重算）；
    // 侧栏列出完整清单，同时把每个概念在正文中的首次出现原地变成可点的维基百科链接。

