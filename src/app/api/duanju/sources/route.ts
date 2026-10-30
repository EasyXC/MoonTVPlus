/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextResponse } from 'next/server';

import { getCacheTime } from '@/lib/config';
import { getDuanjuSources } from '@/lib/duanju';

export const runtime = 'nodejs';

/**
 * 获取包含短剧分类的视频源列表
 */
export async function GET() {
  try {
    const { sources, done } = await getDuanjuSources();
    const cacheTime = await getCacheTime();

    return NextResponse.json(
      {
        code: 200,
        message: '获取成功',
        data: sources,
        // done=false 表示分批探测尚未完成（Cloudflare Workers 子请求限制），
        // 前端应稍后重试直至 done=true
        done,
      },
      {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
        },
      }
    );
  } catch (error) {
    console.error('获取短剧视频源失败:', error);
    return NextResponse.json(
      {
        code: 500,
        message: '获取短剧视频源失败',
        error: (error as Error).message,
      },
      { status: 500 }
    );
  }
}
