/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { API_CONFIG, getAvailableApiSites } from '@/lib/config';
import { db } from '@/lib/db';
import { parseJsonLosslessIntegers } from '@/lib/json';
import { isDuanjuTypeName } from '@/lib/duanju.client';

export { isDuanjuTypeName };

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

// 缓存过期时间：2 小时（毫秒）
const DUANJU_CACHE_TTL = 2 * 60 * 60 * 1000;

interface DuanjuCacheData {
  sources: DuanjuSource[];
  timestamp: number;
}

/**
 * 获取包含短剧分类的视频源列表
 * 缓存 2 小时后自动过期，避免空结果被永久缓存；
 * 兼容旧格式（直接是数组）的缓存，缺少分类信息时自动重建。
 */
export async function getDuanjuSources(): Promise<DuanjuSource[]> {
  try {
    // 先查询数据库中是否有缓存
    const cachedData = await db.getGlobalValue('duanju');

    if (cachedData !== null) {
      let cachedSources: DuanjuSource[] | null = null;
      let cacheTime: number | undefined;

      try {
        const parsed = JSON.parse(cachedData);
        if (Array.isArray(parsed)) {
          // 旧格式：直接是数组，视为已过期（无时间戳）
          cachedSources = parsed as DuanjuSource[];
        } else if (parsed && Array.isArray(parsed.sources)) {
          cachedSources = parsed.sources as DuanjuSource[];
          cacheTime = parsed.timestamp as number | undefined;
        }
      } catch {
        // 解析失败，视为无缓存
        cachedSources = null;
      }

      if (cachedSources !== null) {
        const isFresh =
          typeof cacheTime === 'number' &&
          Date.now() - cacheTime < DUANJU_CACHE_TTL;
        // 旧版本缓存只保存采集源，不包含短剧分类 ID。缺少 typeId 时自动重建缓存。
        const hasTypeInfo =
          cachedSources.length === 0 ||
          cachedSources.every((source) => source.typeId);

        if (isFresh && hasTypeInfo) {
          return cachedSources;
        }

        if (!isFresh) {
          console.log('短剧源缓存已过期，重新查询...');
        } else {
          console.log('短剧视频源缓存缺少分类信息，重新筛选...');
        }
      }
    }

    // 没有缓存或缓存过期，开始筛选
    console.log('开始筛选包含短剧分类的视频源...');
    const allSources = await getAvailableApiSites();
    const duanjuSources: DuanjuSource[] = [];

    // 并发请求所有视频源的分类列表
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

        const data = parseJsonLosslessIntegers<CmsClassResponse>(
          await response.text()
        );

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

    // 存入数据库，带时间戳（空数组也会存，但会按 TTL 过期后重查）
    const cacheData: DuanjuCacheData = {
      sources: duanjuSources,
      timestamp: Date.now(),
    };
    await db.setGlobalValue('duanju', JSON.stringify(cacheData));

    return duanjuSources;
  } catch (error) {
    console.error('获取短剧视频源失败:', error);
    throw error;
  }
}
