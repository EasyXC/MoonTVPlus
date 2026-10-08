/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { API_CONFIG, getAvailableApiSites } from '@/lib/config';
import { db } from '@/lib/db';

interface CmsClassResponse {
  class?: Array<{
    type_id: string | number;
    type_name: string;
  }>;
}

export interface DuanjuSource {
  key: string;
  name: string;
  api: string;
  typeId?: string;
  typeName?: string;
}

export function isDuanjuTypeName(typeName: string): boolean {
  const normalizedTypeName = typeName.toLowerCase();
  return (
    normalizedTypeName.includes('短剧') ||
    normalizedTypeName.includes('短视频') ||
    normalizedTypeName.includes('微短剧')
  );
}

// 短剧视频源缓存有效期：6 小时
const DUANJU_SOURCES_CACHE_DURATION = 6 * 60 * 60 * 1000;

// 兼容新旧两种缓存格式：新格式为 { ts, sources }，旧格式为纯数组
function parseDuanjuSourcesCache(
  cachedData: string | null
): { sources: DuanjuSource[]; ts: number } | null {
  if (cachedData === null) return null;
  try {
    const parsed = JSON.parse(cachedData);
    if (Array.isArray(parsed)) {
      // 旧版本纯数组缓存：无法确定写入时间，视为无效缓存，强制重建
      return null;
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.ts === 'number' &&
      Array.isArray(parsed.sources)
    ) {
      return parsed as { sources: DuanjuSource[]; ts: number };
    }
    return null;
  } catch {
    // 缓存损坏时视为无效，走重新筛选
    return null;
  }
}

/**
 * 获取包含短剧分类的视频源列表
 */
export async function getDuanjuSources(): Promise<DuanjuSource[]> {
  try {
    // 先查询数据库中是否有缓存
    const cachedData = await db.getGlobalValue('duanju');
    const cache = parseDuanjuSourcesCache(cachedData);

    if (cache !== null) {
      const cachedSources = cache.sources;
      const isExpired = Date.now() - cache.ts > DUANJU_SOURCES_CACHE_DURATION;
      // 旧版本缓存只保存采集源，不包含短剧分类 ID。缺少 typeId 时自动重建缓存。
      // 空数组缓存仅在有效期内直接返回，超时后重新筛选，避免"空缓存永久锁死"。
      if (
        !isExpired &&
        (cachedSources.length === 0 ||
          cachedSources.every((source) => source.typeId))
      ) {
        return cachedSources;
      }

      console.log('短剧视频源缓存过期或缺少分类信息，重新筛选...');
    }

    // 没有缓存，开始筛选
    console.log('开始筛选包含短剧分类的视频源...');
    const allSources = await getAvailableApiSites();
    const duanjuSources: DuanjuSource[] = [];

    // 并发���求所有视频源的分类列表
    const checkPromises = allSources.map(async (source) => {
      try {
        const classUrl = `${source.api}?ac=list`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(classUrl, {
          headers: API_CONFIG.search.headers,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          return null;
        }

        const data: CmsClassResponse = await response.json();

        // 检查是否有短剧分类
        if (data.class && Array.isArray(data.class)) {
          const duanjuType = data.class.find((item) =>
            isDuanjuTypeName(item.type_name || '')
          );

          if (duanjuType) {
            return {
              key: source.key,
              name: source.name,
              api: source.api,
              typeId: duanjuType.type_id.toString(),
              typeName: duanjuType.type_name,
            };
          }
        }

        return null;
      } catch (error) {
        // 请求失败或超时，忽略该源
        console.error(`检查视频源 ${source.name} 失败:`, error);
        return null;
      }
    });

    const results = await Promise.all(checkPromises);

    // 过滤掉null值
    results.forEach((result) => {
      if (result) {
        duanjuSources.push(result);
      }
    });

    console.log(`找到 ${duanjuSources.length} 个包含短剧分类的视频源`);

    // 存入数据库（带时间戳；即使空数组也存，超时后会自动重建，避免空缓存永久锁死）
    await db.setGlobalValue(
      'duanju',
      JSON.stringify({ ts: Date.now(), sources: duanjuSources })
    );

    return duanjuSources;
  } catch (error) {
    console.error('获取短剧视频源失败:', error);
    throw error;
  }
}
