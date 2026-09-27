import { describe, expect, it } from "vitest";
import { parseDuration, parseFeed } from "../src/rss";

// 与 test/fixtures/rss/sample.xml 同源（该文件亦用于 Python oracle 复算）。
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>忽左忽右</title>
    <itunes:image href="https://cdn.example.com/cover.jpg"/>
    <item>
      <title>474 孙立天谈康熙废储</title>
      <link>https://example.com/episodes/474</link>
      <guid isPermaLink="false">episode-guid-474</guid>
      <pubDate>Tue, 19 May 2026 08:00:00 +0000</pubDate>
      <itunes:duration>01:02:03</itunes:duration>
      <description>短简介，会被更长的 content:encoded 覆盖。</description>
      <content:encoded><![CDATA[<p>这是<strong>完整</strong>的 show notes。</p><br/>第二段带时间线。]]></content:encoded>
      <enclosure url="https://cdn.example.com/audio/474.mp3" type="audio/mpeg" length="50331648"/>
    </item>
    <item>
      <title>473 漫谈卢梭</title>
      <link>https://example.com/episodes/473</link>
      <pubDate>Fri, 15 May 2026 08:00:00 +0000</pubDate>
      <itunes:duration>58:30</itunes:duration>
      <summary>只有 summary 字段。</summary>
      <enclosure url="https://cdn.example.com/audio/473.m4a" type="audio/mp4" length="40000000"/>
    </item>
    <item>
      <title>短单集</title>
      <link>https://example.com/episodes/short</link>
      <pubDate>Mon, 11 May 2026 08:00:00 +0000</pubDate>
      <itunes:duration>90</itunes:duration>
      <description>时长以秒计。</description>
      <enclosure url="https://cdn.example.com/audio/short.mp3" type="audio/mpeg" length="1500000"/>
    </item>
    <item>
      <title>无音频，应被跳过</title>
      <link>https://example.com/episodes/noaudio</link>
      <pubDate>Sun, 10 May 2026 08:00:00 +0000</pubDate>
      <itunes:duration>10:00</itunes:duration>
      <description>没有 enclosure。</description>
    </item>
  </channel>
</rss>`;

describe("parseFeed (golden parity vs original feedparser)", () => {
  const { channelImage, episodes } = parseFeed(xml, "忽左忽右");

  it("extracts the channel artwork", () => {
    expect(channelImage).toBe("https://cdn.example.com/cover.jpg");
  });

  it("skips items without audio and normalizes the rest", () => {
    expect(episodes.map(e => e.title)).toEqual([
      "474 孙立天谈康熙废储",
      "473 漫谈卢梭",
      "短单集",
    ]);
  });

  it("matches the oracle for the content:encoded episode", () => {
    expect(episodes[0]).toEqual({
      podcast_name: "忽左忽右",
      title: "474 孙立天谈康熙废储",
      link: "https://example.com/episodes/474",
      audio_url: "https://cdn.example.com/audio/474.mp3",
      published: "Tue, 19 May 2026 08:00:00 +0000",
      date: "20260519",
      duration: "01:02:03",
      duration_seconds: 3723,
      summary: "这是完整的 show notes。\n\n第二段带时间线。",
      id: "episode-guid-474",
    });
  });

  it("falls back to link as id when guid is missing (MM:SS duration)", () => {
    expect(episodes[1].id).toBe("https://example.com/episodes/473");
    expect(episodes[1].duration_seconds).toBe(3510);
    expect(episodes[1].summary).toBe("只有 summary 字段。");
    expect(episodes[1].date).toBe("20260515");
  });

  it("parses bare-seconds duration", () => {
    expect(episodes[2].duration).toBe("90");
    expect(episodes[2].duration_seconds).toBe(90);
  });
});

describe("parseFeed XML parser compatibility", () => {
  it("preserves v4 entity handling and numeric-looking identifiers", () => {
    const feed = parseFeed(`<rss><channel>
      <title>News &amp; Culture &#x4E2D;</title>
      <itunes:image href="https://cdn.example.com/cover?a=1&amp;b=2"/>
      <item>
        <title>&quot;001&quot; &amp; &#20013;</title>
        <guid isPermaLink="false">00123</guid>
        <link>https://example.com/episode?a=1&amp;b=2</link>
        <itunes:duration>0090</itunes:duration>
        <description>&lt;p&gt;Tom &amp; Jerry&lt;/p&gt;</description>
        <enclosure url="https://cdn.example.com/audio?a=1&amp;b=2"/>
      </item>
    </channel></rss>`, "News");

    // With the existing options, numeric character references remain literal in v4 and v5.
    expect(feed.channelTitle).toBe("News & Culture &#x4E2D;");
    expect(feed.channelImage).toBe("https://cdn.example.com/cover?a=1&b=2");
    expect(feed.episodes).toHaveLength(1);
    expect(feed.episodes[0]).toMatchObject({
      title: '"001" & &#20013;',
      id: "00123",
      link: "https://example.com/episode?a=1&b=2",
      audio_url: "https://cdn.example.com/audio?a=1&b=2",
      duration: "0090",
      duration_seconds: 90,
      summary: "Tom & Jerry",
    });
  });

  it("keeps CDATA entities literal and normalizes repeated enclosures", () => {
    const feed = parseFeed(`<rss><channel><title>News</title><item>
      <title><![CDATA[Rock &amp; Roll]]></title>
      <guid>00042</guid>
      <content:encoded><![CDATA[<p>A &amp; B</p><br/>第二段]]></content:encoded>
      <enclosure url="https://cdn.example.com/first.mp3"/>
      <enclosure url="https://cdn.example.com/second.mp3"/>
    </item></channel></rss>`, "News");

    expect(feed.episodes).toHaveLength(1);
    expect(feed.episodes[0]).toMatchObject({
      title: "Rock &amp; Roll",
      id: "00042",
      audio_url: "https://cdn.example.com/first.mp3",
      summary: "A &amp; B\n\n第二段",
    });
  });
});

describe("parseDuration", () => {
  it("handles HH:MM:SS, MM:SS, seconds and garbage", () => {
    expect(parseDuration("01:02:03")).toBe(3723);
    expect(parseDuration("58:30")).toBe(3510);
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("")).toBe(0);
    expect(parseDuration("abc")).toBe(0);
  });
});
