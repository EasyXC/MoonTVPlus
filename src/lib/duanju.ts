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

// 每次调用最多探测的源数量。
// Cloudflare Workers 免费版单次调用最多 50 个子请求（KV 读写也计入），
// 留足余量，分多次调用把全部源探测完。
const DUANJU_BATCH_SIZE = 30;

interface DuanjuCacheData {
  sources: DuanjuSource[];
  timestamp: number;
  // 探测是否已覆盖全部源；分批探测进行中为 false
  done?: boolean;
  // 已探测过的源 key 列表（用于分批续探）
  checkedKeys?: string[];
}

/**
 * 获取包含短剧分类的视频源列表
 *
 * 缓存 2 小时后自动过期，避免空结果被永久缓存；
 * 兼容旧格式（直接是数组）的缓存，缺少分类信息时自动重建。
 *
 * 探测分批进行：每次调用最多探测 DUANJU_BATCH_SIZE 个源，结果累积进缓存，
 * 返回值 done=false 表示还有源未探测完，调用方应稍后重试直至 done=true。
 */
export async function getDuanjuSources(): Promise<{
  sources: DuanjuSource[];
  done: boolean;
}> {
  try {
    // 先查询数据库中是否有缓存
    const cachedData = await db.getGlobalValue('duanju');
    let cached: DuanjuCacheData | null = null;

    if (cachedData !== null) {
      try {
        const parsed = JSON.parse(cachedData);
        if (Array.isArray(parsed)) {
          // 旧格式：直接是数组，无时间戳，视为已过期
          cached = {
            sources: parsed as DuanjuSource[],
            timestamp: 0,
            done: undefined,
            checkedKeys: [],
          };
        } else if (parsed && Array.isArray(parsed.sources)) {
          cached = {
            sources: parsed.sources as DuanjuSource[],
            timestamp:
              typeof parsed.timestamp === 'number' ? parsed.timestamp : 0,
            done: parsed.done as boolean | undefined,
            checkedKeys: Array.isArray(parsed.checkedKeys)
              ? (parsed.checkedKeys as string[])
              : [],
          };
        }
      } catch {
        // 解析失败，视为无缓存
        cached = null;
      }
    }

    if (cached) {
      const isFresh =
        typeof cached.timestamp === 'number' &&
        Date.now() - cached.timestamp < DUANJU_CACHE_TTL;
      // 旧版本缓存只保存采集源，不包含短剧分类 ID。缺少 typeId 时自动重建缓存。
      const hasTypeInfo =
        cached.sources.length === 0 ||
        cached.sources.every((source) => source.typeId);

      if (cached.done === true) {
        // 探测已完成的完整缓存
        if (isFresh && hasTypeInfo) {
          return { sources: cached.sources, done: true };
        }
        // 过期：重置进度，重新分批探测
        if (!isFresh) {
          console.log('短剧源缓存已过期，重新分批探测...');
        } else {
          console.log('短剧视频源缓存缺少分类信息，重新分批探测...');
        }
        cached = { sources: [], timestamp: 0, done: false, checkedKeys: [] };
      } else if (cached.done === undefined) {
        // 旧格式缓存（无 done 标记）：完整时升级为新格式直接返回
        if (isFresh && hasTypeInfo) {
          const upgraded: DuanjuCacheData = {
            sources: cached.sources,
            timestamp: cached.timestamp,
            done: true,
            checkedKeys: [],
          };
          try {
            await db.setGlobalValue('duanju', JSON.stringify(upgraded));
          } catch {
            // 升级失败不影响返回
          }
          return { sources: cached.sources, done: true };
        }
        cached = { sources: [], timestamp: 0, done: false, checkedKeys: [] };
      }
      // cached.done === false：分批探测进行中，直接继续下一批
    } else {
      cached = { sources: [], timestamp: 0, done: false, checkedKeys: [] };
    }

    const allSources = await getAvailableApiSites();
    const checkedSet = new Set(cached.checkedKeys || []);
    const sourcesMap = new Map(
      cached.sources.map((source) => [source.key, source])
    );

    const pending = allSources.filter((source) => !checkedSet.has(source.key));
    const batch = pending.slice(0, DUANJU_BATCH_SIZE);
    console.log(
      `分批探测短剧源：本轮 ${batch.length} 个，剩余 ${pending.length} 个，共 ${allSources.length} 个`
    );

    // 并发请求本批视频源的分类列表
    await Promise.all(
      batch.map(async (source) => {
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
            return;
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
              sourcesMap.set(source.key, {
                key: source.key,
                name: source.name,
                api: source.api,
                typeId: duanjuType.type_id.toString(),
                typeName: duanjuType.type_name,
              });
            }
          }
        } catch (error) {
          // 请求失败或超时，忽略该源
          console.error(`检查视频源 ${source.name} 失败:`, error);
        }
      })
    );

    // 无论是否找到短剧分类，本轮探测过的源都标记为已检查
    batch.forEach((source) => checkedSet.add(source.key));

    const done = pending.length <= DUANJU_BATCH_SIZE;
    const duanjuSources = Array.from(sourcesMap.values());

    if (done) {
      console.log(
        `探测完成，共找到 ${duanjuSources.length} 个包含短剧分类的视频源`
      );
    } else {
      console.log(
        `本轮结束，已累积 ${duanjuSources.length} 个短剧源，剩余 ${
          allSources.length - checkedSet.size
        } 个源待探测`
      );
    }

    // 存入数据库，带时间戳与探测进度
    const cacheData: DuanjuCacheData = {
      sources: duanjuSources,
      timestamp: Date.now(),
      done,
      checkedKeys: Array.from(checkedSet),
    };
    await db.setGlobalValue('duanju', JSON.stringify(cacheData));

    return { sources: duanjuSources, done };
  } catch (error) {
    console.error('获取短剧视频源失败:', error);
    throw error;
  }
}
