    // ── 稿件永久链接：<base>/a/<task_id> ─────────────────────
    // 公开浏览中打开稿件时把地址换成永久链接（pushState），关闭时回到工作区，前进 / 后退按地址
    // 打开或关闭阅读器；直接访问 /a/<id> 时服务端已注入该稿件的 head，首屏直接打开它。
    // 控制模式（/manage）的地址保持不变，但「分享」给出的始终是公开永久链接。
    var ARTICLE_PATH = /^(.*?)\/a\/([0-9a-f-]+)$/i;
    var SITE_TITLE = 'Read Podcast';
    var _shareFeedbackTimer = null;

    function articlePermalinkPath(taskId) {
      return appUrl('/a/' + encodeURIComponent(String(taskId || '')));
    }

    function articlePermalink(taskId) {
      return window.location.origin + articlePermalinkPath(taskId);
    }

    function permalinkArticleId() {
      var match = String(window.location.pathname || '').replace(/\/+$/, '').match(ARTICLE_PATH);
      return match ? match[2] : null;
    }

    // openManuscript 调用：公开浏览把地址与标题换成这篇稿件。
    function onArticleOpened(taskId, title) {
      if (IS_MANAGE) return;
      document.title = title ? String(title) + ' · ' + SITE_TITLE : SITE_TITLE;
      if (!window.history || !window.history.pushState || permalinkArticleId() === taskId) return;
      window.history.pushState({ readPodcastArticle: taskId, title: title || '' }, '', articlePermalinkPath(taskId));
    }

    // closeManuscript 调用：回到打开前的地址；直接从永久链接进入时替换成工作区首页。
    function onArticleClosed() {
      if (IS_MANAGE) return;
      document.title = SITE_TITLE;
      if (!permalinkArticleId() || !window.history) return;
      if (window.history.state && window.history.state.readPodcastArticle) window.history.back();
      else if (window.history.replaceState) window.history.replaceState(null, '', appUrl('/'));
    }

    function knownArticleTitle(taskId) {
      var state = window.history && window.history.state;
      if (state && state.readPodcastArticle === taskId && state.title) return state.title;
      var article = (_libraryArticles || []).find(function (item) { return item && String(item.task_id) === taskId; });
      return article && article.title ? article.title : '';
    }

    function syncReaderWithLocation() {
      if (IS_MANAGE) return;
      var taskId = permalinkArticleId();
      var isOpen = byId('manuscript-reader').classList.contains('is-open');
      if (taskId && (!isOpen || _currentReadingTaskId !== taskId)) openManuscript(taskId, null, { task_id: taskId, title: knownArticleTitle(taskId) });
      else if (!taskId && isOpen) closeManuscript();
    }

    function flashShareFeedback(key) {
      var button = byId('reader-share-btn');
      var label = byId('reader-share-label');
      if (!button || !label) return;
      label.textContent = t(key);
      button.classList.toggle('is-copied', key === 'reader.link_copied');
      clearTimeout(_shareFeedbackTimer);
      _shareFeedbackTimer = setTimeout(function () {
        label.textContent = t('reader.share');
        button.classList.remove('is-copied');
      }, 2000);
    }

    function copyTextFallback(text) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (ignore) {}
      area.remove();
      return ok;
    }

    function copyArticleLink(url) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(
          function () { flashShareFeedback('reader.link_copied'); },
          function () { flashShareFeedback(copyTextFallback(url) ? 'reader.link_copied' : 'reader.copy_failed'); }
        );
        return;
      }
      flashShareFeedback(copyTextFallback(url) ? 'reader.link_copied' : 'reader.copy_failed');
    }

    function shareCurrentArticle() {
      if (!_currentReadingTaskId) return;
      var url = articlePermalink(_currentReadingTaskId);
      var title = byId('reader-title-text').textContent || SITE_TITLE;
      if (navigator.share) {
        navigator.share({ title: title, url: url }).catch(function (error) {
          if (!error || error.name !== 'AbortError') copyArticleLink(url);
        });
        return;
      }
      copyArticleLink(url);
    }

    byId('reader-share-btn').addEventListener('click', shareCurrentArticle);
    window.addEventListener('popstate', syncReaderWithLocation);

    // 首屏：服务端只对已发布稿件注入 read-podcast:article；404 外壳回到工作区首页。
    (function openPermalinkOnLoad() {
      if (IS_MANAGE || !APP_LOCATION.article) return;
      var marker = document.querySelector('meta[name="read-podcast:article"]');
      if (!marker || marker.getAttribute('content') !== APP_LOCATION.article) {
        if (window.history && window.history.replaceState) window.history.replaceState(null, '', appUrl('/'));
        return;
      }
      var ogTitle = document.querySelector('meta[property="og:title"]');
      var serverTitle = document.title;
      openManuscript(APP_LOCATION.article, null, { task_id: APP_LOCATION.article, title: ogTitle ? ogTitle.getAttribute('content') : '' });
      document.title = serverTitle;
    }());
