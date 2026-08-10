import re
import logging
import warnings
import requests
import feedparser
from urllib3.exceptions import InsecureRequestWarning

from modules.config import settings
from modules.network_security import read_limited, redact_url, safe_get

logger = logging.getLogger(__name__)

RE_BR = re.compile(r'<br\s*/?>', re.IGNORECASE)
RE_P_CLOSE = re.compile(r'</p>', re.IGNORECASE)
RE_TAGS = re.compile(r'<[^>]+>')
MAX_RSS_BYTES = max(1024, int(settings.RUNTIME_CONFIG.get("max_rss_bytes", 10 * 1024 * 1024)))


class RSSParser:
    def __init__(self, rss_url, name, insecure_tls=False):
        self.rss_url = rss_url
        self.name = name
        self.insecure_tls = bool(insecure_tls)
        self.channel_image = ""

    @staticmethod
    def _extract_channel_image(feed) -> str:
        """从频道信息里取封面图地址（itunes:image 优先），失败返回空串。"""
        try:
            channel = getattr(feed, "feed", None) or {}
            itunes_image = channel.get("image")
            if isinstance(itunes_image, dict):
                href = itunes_image.get("href") or itunes_image.get("url") or ""
                if href:
                    return str(href)
            href = channel.get("itunes_image", {})
            if isinstance(href, dict) and href.get("href"):
                return str(href["href"])
        except Exception:
            return ""
        return ""

    def fetch_episodes(self, limit=5, min_duration_seconds=0, reverse=False, filter_id=None, filter_title=None):
        # 获取播客节目，支持从旧(reverse=True)或从新(reverse=False)开始，或指定 ID/标题过滤
        logger.info("正在获取播客节目 [%s]: %s", self.name, redact_url(self.rss_url))
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8'
        }

        try:
            response = self._get(headers, verify=True)
            response.raise_for_status()
            rss_content = read_limited(response, MAX_RSS_BYTES)
            response.close()
            feed = feedparser.parse(rss_content)
        except requests.exceptions.SSLError:
            logger.warning("RSS 源证书校验失败 [%s]", self.name)
            if not self.insecure_tls:
                return []
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", InsecureRequestWarning)
                response = self._get(headers, verify=False)
            response.raise_for_status()
            rss_content = read_limited(response, MAX_RSS_BYTES)
            response.close()
            feed = feedparser.parse(rss_content)
        except Exception:
            logger.error("访问 RSS URL 失败 [%s]（URL 与异常详情未写入日志）", self.name)
            # 如果是 stovol.club 这种经常超时的，尝试备选镜像或稍后重试逻辑
            return []
        
        self.channel_image = self._extract_channel_image(feed) or self.channel_image

        if feed.bozo and not feed.entries:
            logger.error(f"解析 RSS 失败 [{self.name}]: {feed.bozo_exception}")
            return []
        
        entries = feed.entries
        if not entries:
            logger.warning("解析结果为空，RSS 源可能未包含剧集列表: %s", redact_url(self.rss_url))
            return []
        
        if reverse:
            entries = list(reversed(entries))
        
        episodes = []
        for entry in entries:
            # 基础信息清洗：优先选取包含完整时间线 Show Notes 的描述字段
            title = entry.get('title', 'Untitled').strip()
            
            raw_summary_candidates = []
            if hasattr(entry, 'content') and entry.content:
                for c in entry.content:
                    if isinstance(c, dict) and c.get('value'):
                        raw_summary_candidates.append(c.get('value'))
            if entry.get('description'):
                raw_summary_candidates.append(entry.get('description'))
            if entry.get('summary'):
                raw_summary_candidates.append(entry.get('summary'))
            
            raw_summary = max(raw_summary_candidates, key=len) if raw_summary_candidates else ""
            summary = RE_BR.sub('\n', raw_summary)
            summary = RE_P_CLOSE.sub('\n', summary)
            summary = RE_TAGS.sub('', summary).strip()
            
            episode_id = entry.get('id', entry.get('link', ''))
            
            # ID 过滤
            if filter_id and filter_id not in episode_id:
                continue
                
            # 标题过滤 (模糊匹配)
            if filter_title and filter_title not in title:
                continue
            
            if len(episodes) >= limit and not (filter_id or filter_title):
                break
                
            # 提取时长
            duration_str = entry.get('itunes_duration', '0')
            duration_seconds = self._parse_duration(duration_str)
            
            if duration_seconds < min_duration_seconds:
                logger.debug(f"跳过较短的节目: {title} ({duration_seconds}s)")
                continue
                
            # 提取音频链接
            audio_url = ""
            if hasattr(entry, 'links'):
                for link in entry.links:
                    if link.get('rel') == 'enclosure' or 'audio' in link.get('type', ''):
                        audio_url = link.href
                        break
            
            if not audio_url and hasattr(entry, 'enclosures') and entry.enclosures:
                audio_url = entry.enclosures[0].href
                
            if not audio_url:
                logger.warning(f"未发现音频链接，跳过节目: {title}")
                continue
                
            episodes.append({
                'podcast_name': self.name,
                'title': title,
                'link': entry.get('link', ''),
                'audio_url': audio_url,
                'published': entry.get('published', ''),
                'published_parsed': entry.get('published_parsed', None),
                'duration': duration_str,
                'duration_seconds': duration_seconds,
                'summary': summary,
                'id': episode_id
            })
            
            if (filter_id or filter_title) and len(episodes) >= limit:
                break
                
        return episodes

    def _get(self, headers, *, verify):
        return safe_get(
            self.rss_url,
            headers=headers,
            timeout=30,
            verify=verify,
            stream=True,
        )

    def _parse_duration(self, duration_str):
        # 解析多种格式的时长字符串为秒
        if not duration_str:
            return 0
        try:
            duration_str = str(duration_str).strip()
            if ':' in duration_str:
                parts = duration_str.split(':')
                if len(parts) == 3: # HH:MM:SS
                    return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                elif len(parts) == 2: # MM:SS
                    return int(parts[0]) * 60 + int(parts[1])
            return int(float(duration_str))
        except (ValueError, TypeError):
            return 0
