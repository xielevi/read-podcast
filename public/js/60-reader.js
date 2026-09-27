    function updateReaderStats(rawText) {
      var withoutFrontmatter = String(rawText || '').replace(/^\s*---\s*\n[\s\S]*?\n---\s*\n*/, '');
      var cleanText = withoutFrontmatter.replace(/\s+/g, '');
      var count = cleanText.length;
      var statsEl = byId('reader-meta-stats');
      if (!statsEl) return;
      if (!count) { statsEl.textContent = ''; return; }
      if (getLocale() === 'en') {
        var words = withoutFrontmatter.trim().split(/\s+/).filter(Boolean).length;
        var minutes = Math.max(1, Math.round(words / 220));
        statsEl.textContent = words ? (words + ' words · ~' + minutes + ' min') : '';
      } else {
        var minutes = Math.max(1, Math.round(count / 750));
        var countStr = count >= 10000 ? (count / 10000).toFixed(1) + ' 万字' : count + ' 字';
        statsEl.textContent = count ? (countStr + ' · 约 ' + minutes + ' 分钟') : '';
      }
    }

    function updateReaderProgress(percent) {
      var bounded = Math.min(100, Math.max(0, Number(percent) || 0));
      var rounded = Math.round(bounded);
      var progressRange = byId('reader-progress-range');
      var progressValue = byId('reader-progress-value');
      if (progressRange) progressRange.value = String(bounded);
      if (progressValue) progressValue.textContent = rounded + '%';

      var sheetProgressRange = byId('reader-sheet-progress-range');
      var sheetProgressVal = byId('reader-sheet-progress-val');
      if (sheetProgressRange) sheetProgressRange.value = String(bounded);
      if (sheetProgressVal) sheetProgressVal.textContent = rounded + '%';

      var barProgressLabel = byId('reader-bar-progress-label');
      if (barProgressLabel) barProgressLabel.textContent = (getLocale() === 'en' ? 'Progress ' : '进度 ') + rounded + '%';

      if (bounded >= 99.5 && _currentReadingRef && !isRead(_currentReadingRef)) {
        setRead(_currentReadingRef, true);
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

    function stripOpeningOutline(markdown) {
      if (markdown == null) return '';
      var raw = String(markdown).replace(/\r\n?/g, '\n');
      var frontmatter = '';
      var body = raw;
      var fmMatch = raw.match(/^(\s*---\s*\n[\s\S]*?\n---\s*\n*)/);
      if (fmMatch) {
        frontmatter = fmMatch[1];
        body = raw.slice(frontmatter.length);
      }

      var leadingWsMatch = body.match(/^\s*/);
      var leadingWs = leadingWsMatch ? leadingWsMatch[0] : '';
      var content = body.slice(leadingWs.length);

      var headingMatch = content.match(/^#{1,6}\s+(?:[📌⏱️🕒]\s*)?(?:节目大纲与时间线|(?:Episode\s+)?Outline\s*(?:&|and)\s*Timeline|Timeline\s*(?:&|and)\s*Outline)\s*[:：]?[^\S\n]*(?:\n|$)/iu);
      if (!headingMatch) return raw;

      var rest = content.slice(headingMatch[0].length);

      var nextHeadingMatch = rest.match(/(?:^|\n)(#{1,6}\s+[^\n]+)/);
      if (nextHeadingMatch && nextHeadingMatch.index !== undefined) {
        var nextHeadingIndex = nextHeadingMatch.index === 0 ? 0 : nextHeadingMatch.index + 1;
        return frontmatter + rest.slice(nextHeadingIndex);
      }

      var hrMatch = rest.match(/(?:^|\n)\s*(?:---|\*\*\*|___)\s*\n*/);
      if (hrMatch && hrMatch.index !== undefined) {
        var afterHr = hrMatch.index + hrMatch[0].length;
        return frontmatter + rest.slice(afterHr);
      }

      var lines = rest.split('\n');
      var firstNonListIndex = -1;
      for (var i = 0; i < lines.length; i++) {
        var trimmed = lines[i].trim();
        if (!trimmed) continue;
        if (/^[-*+]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed) || /^>\s*/.test(trimmed)) continue;
        firstNonListIndex = i;
        break;
      }
      if (firstNonListIndex !== -1) {
        return frontmatter + lines.slice(firstNonListIndex).join('\n');
      }

      return frontmatter;
    }

    function renderBasicMarkdown(markdown) {
      if (markdown == null) return '';
      var raw = stripOpeningOutline(markdown);
      raw = String(raw).replace(/\r\n?/g, '\n');
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

    function setFontSize(size, skipSave) {
      _currentFontSize = Math.max(14, Math.min(28, size));
      var body = byId('manuscript-body');
      if (body) body.style.fontSize = _currentFontSize + 'px';
      var indicator = byId('font-size-val');
      if (indicator) indicator.textContent = String(_currentFontSize);
      if (!skipSave) savePreference('font_size', _currentFontSize);
    }

    function setTheme(theme, skipSave) {
      _currentTheme = theme;
      var normalizedTheme = theme === 'light' ? 'paper' : theme;
      var reader = document.getElementById('manuscript-reader');
      if (reader) reader.dataset.readerTheme = normalizedTheme;
      document.querySelectorAll('.theme-picker [data-theme]').forEach(function (btn) {
        var isMatch = btn.dataset.theme === normalizedTheme || (normalizedTheme === 'paper' && btn.id === 'theme-light-btn');
        btn.classList.toggle('active', isMatch);
      });
      if (!skipSave) savePreference('reader_theme', theme);
    }

    function setFontPreset(preset, skipSave) {
      _currentFontPreset = preset === 'modern' ? 'modern' : 'classical';
      var reader = document.getElementById('manuscript-reader');
      if (reader) reader.dataset.readerFont = _currentFontPreset;
      document.querySelectorAll('[data-preset]').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.preset === _currentFontPreset);
      });
      if (!skipSave) savePreference('font_preset', _currentFontPreset);
    }

    function setLineHeight(leading, skipSave) {
      _currentLineHeight = (leading === 'compact' || leading === 'relaxed') ? leading : 'normal';
      var reader = document.getElementById('manuscript-reader');
      if (reader) reader.dataset.readerLeading = _currentLineHeight;
      document.querySelectorAll('[data-leading]').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.leading === _currentLineHeight);
      });
      if (!skipSave) savePreference('line_height', _currentLineHeight);
    }

    function applyReaderPreferences(prefs) {
      var source = prefs || _cloudPrefs || {};
      if (source.reader_theme) setTheme(source.reader_theme, true);
      else if (source.readerTheme) setTheme(source.readerTheme, true);
      if (source.font_preset) setFontPreset(source.font_preset, true);
      else if (source.fontPreset) setFontPreset(source.fontPreset, true);
      if (source.font_size) setFontSize(source.font_size, true);
      else if (source.fontSize) setFontSize(source.fontSize, true);
      if (source.line_height) setLineHeight(source.line_height, true);
      else if (source.lineHeight) setLineHeight(source.lineHeight, true);
    }

    function closeReaderSheets() {
      var toc = byId('reader-toc');
      if (toc) toc.classList.remove('is-open');
      var progressSheet = byId('reader-progress-sheet');
      if (progressSheet) progressSheet.classList.remove('is-open');
      var backdrop = byId('reader-sheet-backdrop');
      if (backdrop) backdrop.classList.remove('is-open');
      var appearanceMenu = byId('reader-appearance-menu');
      if (appearanceMenu) appearanceMenu.removeAttribute('open');
      document.querySelectorAll('.reader-bar-btn').forEach(function (btn) {
        btn.classList.remove('active');
      });
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

    function openManuscript(taskId, episode, article) {
      var cleanId = String(taskId || '').trim();
      if (!cleanId) return;
      closeEpisodeSummary();
      closeReaderSheets();
      _currentReadingTaskId = cleanId;
      var task = _taskHistory.find(function (item) { return String(item.id) === cleanId; });
      // 已读身份：来自单集用 episode_id；来自任务 / 稿件时优先其 episode_id，导入音频则用稿件的 task_id
      var source = task || article;
      _currentReadingRef = episode ? episodeReadRef(episode) : { episode_id: source && source.episode_id ? String(source.episode_id) : null, task_id: cleanId };
      var title = (task && task.episode_title) || (article && article.title) || '';
      byId('reader-title').textContent = title ? String(title) : '阅读';
      byId('reader-download').href = articleUrl(cleanId, '/download');
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
      
      applyReaderPreferences();

      fetch(articleUrl(cleanId, '/content'))
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
          
          var presentationContent = stripOpeningOutline(result.content);
          updateReaderStats(presentationContent);
          var renderedHtml = renderBasicMarkdown(presentationContent);
          byId('manuscript-body').innerHTML = renderedHtml;
          
          var headings = byId('manuscript-body').querySelectorAll('h1, h2, h3');
          var tocLinks = [];
          if (headings.length > 0) {
            var tocHead = document.createElement('div');
            tocHead.className = 'reader-sheet-head reader-toc-sheet-head';
            var tocTitle = document.createElement('h3');
            tocTitle.textContent = '大纲目录';
            tocHead.appendChild(tocTitle);
            var tocCloseBtn = document.createElement('button');
            tocCloseBtn.className = 'close-btn reader-sheet-close';
            tocCloseBtn.type = 'button';
            tocCloseBtn.setAttribute('aria-label', '关闭目录');
            tocCloseBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
            tocCloseBtn.addEventListener('click', closeReaderSheets);
            tocHead.appendChild(tocCloseBtn);
            tocContainer.appendChild(tocHead);
            
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
                if (window.innerWidth <= 780) closeReaderSheets();
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
          setHidden(tocContainer, false);

          // 阅读位置只在控制模式记忆；公开浏览每次从头开始，不保存任何读者状态。
          var saved = IS_MANAGE ? localStorage.getItem('scroll_pos_' + cleanId) : null;
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

