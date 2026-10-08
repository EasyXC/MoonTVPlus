/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextResponse } from 'next/server';

import { API_CONFIG, getCacheTime } from '@/lib/config';
import { getDuanjuSources } from '@/lib/duanju';
import { SearchResult } from '@/lib/types';
import { cleanHtmlTags } from '@/lib/utils';

export const runtime = 'nodejs';

// 服务端内存缓存
let cachedRecommends: {
  timestamp: number;
  data: SearchResult[];
} | null = null;

interface ApiSearchItem {
  vod_id: string;
  vod_name: string;
  vod_pic: string;
  vod_remarks?: string;
  vod_play_url?: string;
  vod_class?: string;
  vod_year?: string;
  vod_content?: string;
  vod_douban_id?: number;
  type_name?: string;
}

interface CmsClassItem {
  type_id: string | number;
  type_pid?: string | number;
  type_name: string;
}

interface CmsClassResponse {
  class?: CmsClassItem[];
}

// 请求指定分类下的视频列表
const fetchVideoList = async (api: string, typeId: string | number) => {
  const response = await fetch(`${api}?ac=videolist&t=${typeId}&pg=1`, {
    headers: API_CONFIG.search.headers,
  });
  if (!response.ok) return null;
  const data = await response.json();
  if (!data?.list || !Array.isArray(data.list)) return null;
  return data.list as ApiSearchItem[];
};

/**
 * 获取热播短剧推荐视频
 */
export async function GET() {
  try {
    // 检查内存缓存
    const now = Date.now();
    const CACHE_DURATION = 60 * 60 * 1000; // 1小时

    if (cachedRecommends && now - cachedRecommends.timestamp < CACHE_DURATION) {
      console.log('使用缓存的短剧推荐数据');
      const cacheTime = await getCacheTime();
      return NextResponse.json(
        {
          code: 200,
          message: '获取成功',
          data: cachedRecommends.data,
        },
        {
          headers: {
            'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          },
        }
      );
    }

    // 获取短剧视频源列表（内部已检查各源分类，含短剧分类的源会带 typeId）
    const sources = await getDuanjuSources();

    if (!sources || sources.length === 0) {
      return NextResponse.json({
        code: 200,
        message: '暂无短剧视频源',
        data: [],
      });
    }

    // 取第一个视频源，直接使用 getDuanjuSources() 中已筛选出的短剧分类 ID
    const firstSource = sources[0];
    console.log(`使用视频源: ${firstSource.name}`);

    if (!firstSource.typeId) {
      return NextResponse.json({
        code: 200,
        message: '该视频源缺少短剧分类 ID',
        data: [],
      });
    }

    const duanjuTypeId = firstSource.typeId;
    console.log(`短剧分类ID: ${duanjuTypeId}`);

    let videoList: ApiSearchItem[] | null = null;
    const list = await fetchVideoList(firstSource.api, duanjuTypeId);
    if (list && list.length > 0) {
      videoList = list;
    }

    // 一级分类为空时尝试获取子分类（补充兜底：再发一次 ac=list）
    if (!videoList || videoList.length === 0) {
      const classUrl = `${firstSource.api}?ac=list`;
      const classResponse = await fetch(classUrl, {
        headers: API_CONFIG.search.headers,
      });

      if (classResponse.ok) {
        const classData: CmsClassResponse = await classResponse.json();
        const childTypeIds = (classData.class || [])
          .filter(
            (item) =>
              (item.type_pid ?? 0).toString() === duanjuTypeId.toString()
          )
          .map((item) => item.type_id);

        for (const typeId of childTypeIds) {
          const childList = await fetchVideoList(firstSource.api, typeId);
          if (childList && childList.length > 0) {
            videoList = childList;
            break;
          }
        }
      }
    }

    if (!videoList || videoList.length === 0) {
      return NextResponse.json({
        code: 200,
        message: '暂无短剧视频',
        data: [],
      });
    }

    // 处理视频数据
    const videos: SearchResult[] = videoList.map((item: ApiSearchItem) => {
      let episodes: string[] = [];
      let titles: string[] = [];

      // 从 vod_play_url 提取播放链接：与列表页 parseEpisodes 保持一致，
      // 不限制 .m3u8 后缀，避免 mp4/泛解析地址被全部过滤导致首页短剧模块为空
      if (item.vod_play_url) {
        // 先用 $$$ 分割（多个播放线路）
        const vod_play_url_array = item.vod_play_url.split('$$$');
        // 分集之间#分割，标题和播放链接 $ 分割
        vod_play_url_array.forEach((url: string) => {
          const matchEpisodes: string[] = [];
          const matchTitles: string[] = [];
          const title_url_array = url.split('#');
          title_url_array.forEach((title_url: string) => {
            const episode_title_url = title_url.split('$');
            const episodeName = episode_title_url[0]?.trim();
            const episodeUrl = episode_title_url[1]?.trim();
            if (episodeName && episodeUrl) {
              matchTitles.push(episodeName);
              matchEpisodes.push(episodeUrl);
            }
          });
          // 取集数最多的一条线路作为该视频的播放数据
          if (matchEpisodes.length > episodes.length) {
            episodes = matchEpisodes;
            titles = matchTitles;
          }
        });
      }

      return {
        id: item.vod_id.toString(),
        title: item.vod_name.trim().replace(/\s+/g, ' '),
        poster: item.vod_pic,
        episodes,
        episodes_titles: titles,
        source: firstSource.key,
        source_name: firstSource.name,
        class: item.vod_class,
        year: item.vod_year ? item.vod_year.match(/\d{4}/)?.[0] || '' : 'unknown',
        desc: cleanHtmlTags(item.vod_content || ''),
        type_name: item.type_name,
        douban_id: item.vod_douban_id,
      };
    });

    // 过滤掉集数为 0 的结果，并限制返回数量
    const filteredVideos = videos
      .filter((video) => video.episodes.length > 0)
      .slice(0, 20);

    console.log(`返回 ${filteredVideos.length} 个短剧视频`);

    // 保存到内存缓存；空结果不缓存，避免源恢复后仍被 1 小时空缓存顶住
    if (filteredVideos.length > 0) {
      cachedRecommends = {
        timestamp: Date.now(),
        data: filteredVideos,
      };
    } else {
      cachedRecommends = null;
    }

    const cacheTime = await getCacheTime();
    return NextResponse.json(
      {
        code: 200,
        message: '获取成功',
        data: filteredVideos,
      },
      {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
        },
      }
    );
  } catch (error) {
    console.error('获取热播短剧推荐失败:', error);
    return NextResponse.json(
      {
        code: 500,
        message: '获取热播短剧推荐失败',
        error: (error as Error).message,
      },
      { status: 500 }
    );
  }
}
