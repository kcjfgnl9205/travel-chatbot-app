import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { text } from '../../common/parse';
import { AppConfig, CONFIG } from '../../config/app.config';
import { AttractionsRepository } from '../database/repositories/attractions.repository';
import { AttractionImageService } from './attraction-image.service';
import { PlacesService } from '../places/places.service';
import { httpsOnly } from './providers/db.provider';
import {
  CreateAttractionBody,
  ReorderBody,
  UpdateAttractionBody,
} from './attraction-admin.dto';

/**
 * 관광지 관리 API. **관리 화면이 쓰는 CRUD 다.**
 *
 * 0008 까지 이 목록은 구글 Places 가 주고 모델이 순서를 정했다. 0009 부터 **사람이
 * 넣는다** — 그래서 넣을 창구가 필요하고, 그게 이 컨트롤러다.
 *
 * ⚠️ **진단·배치와 같은 토큰을 쓴다(DEBUG_TOKEN).** 운영자만 부르는 경로이고, 토큰을
 *    하나 더 두면 운영에서 관리할 비밀이 하나 더 생긴다. 비어 있으면 이 경로는 404 다 —
 *    토큰을 안 정한 서버에 관리 API 가 열려 있는 것보다 없는 게 낫다.
 *
 * ⚠️ **캐시를 비우지 않는다.** 목록이 있는 도시는 질문할 때마다 DB 를 읽는다
 *    ([AttractionService.peek](./attraction.service.ts)). 고치면 다음 질문부터
 *    바로 반영된다.
 *
 * ⚠️ **모델이 채운 행이 섞여 있다.** 아무도 안 넣은 도시는 빈손으로 두지 않고 모델이
 *    초안을 만들어 넣는다([attraction-backfill.ts](./attraction-backfill.ts)).
 *    `source='ai'` 로 표시되고 `GET …?source=ai` 로 모아 볼 수 있다 — 모델은
 *    폐관한 곳을 그럴듯하게 섞으므로 **가끔 훑어보는 것이 전제다.**
 */
@ApiTags('관광지 관리')
@ApiHeader({
  name: 'X-Debug-Token',
  required: false,
  description: 'DEBUG_TOKEN 을 설정한 경우 필수. 비어 있으면 이 경로는 404 다.',
})
@Controller('api/v1/admin/attractions')
export class AttractionAdminController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly attractions: AttractionsRepository,
    private readonly places: PlacesService,
    private readonly images: AttractionImageService,
  ) {}

  // ------------------------------------------------------------------ 읽기
  @Get()
  @ApiOperation({
    summary: '한 도시의 관광지를 노출 순서대로',
    description:
      '카드에 나가는 것과 **같은 순서**다 (rank → 이름). 관리 화면의 목록이 곧 사용자가 ' +
      '보는 순서라야 순서를 고칠 때 결과를 예측할 수 있다.',
  })
  @ApiQuery({ name: 'city', description: '도시 이름·별칭·슬러그', example: '오사카' })
  @ApiQuery({
    name: 'source',
    required: false,
    enum: ['manual', 'ai'],
    description:
      '`ai` 만 넘기면 **모델이 채운 것만** 본다. 검수 화면이 쓰는 필터다 — ' +
      '모델은 폐관한 곳을 그럴듯하게 섞으므로 가끔 훑어야 한다',
  })
  async list(
    @Query('city') city: string,
    @Headers('x-debug-token') token?: string,
    @Query('source') source?: string,
  ): Promise<{ city: string; items: unknown[] }> {
    this.authorize(token);
    const place = await this.resolveCity(city);
    const filter = source === 'ai' || source === 'manual' ? source : undefined;
    const rows = (await this.attractions.listByCity(place.id, filter)) ?? [];
    return { city: place.canonicalName, items: rows.map(toResponse) };
  }

  // ------------------------------------------------------------------ 생성
  @Post()
  @ApiOperation({
    summary: '관광지 한 곳 등록',
    description:
      '도시가 `places` 에 없으면 먼저 등록한다(사전에 있으면 0원, 없으면 모델 1회).\n\n' +
      '⚠️ **같은 도시에 같은 이름은 두 번 안 들어간다.** DB 유니크 인덱스가 막는다 — ' +
      '관리 화면에서 두 번 저장해도 카드에 같은 줄이 두 번 나가지 않는다.',
  })
  @ApiResponse({ status: 201, description: '등록된 관광지' })
  async create(
    @Body() body: CreateAttractionBody,
    @Headers('x-debug-token') token?: string,
  ): Promise<unknown> {
    this.authorize(token);
    const place = await this.resolveCity(body.city);
    const name = text(body.name);
    if (!name) throw new BadRequestException('name 이 필요하다');

    const row = await this.attractions.create({
      cityId: place.id,
      name,
      // 카드에는 안 나간다 — 사진을 찾을 때만 쓴다.
      nameEn: text(body.nameEn) || null,
      area: text(body.area) || null,
      imageUrl: this.checkedImage(body.imageUrl),
      rank: Number.isFinite(body.rank) ? Number(body.rank) : 0,
    });
    if (!row) {
      // 유니크 위반이 거의 전부다. DB 가 꺼져 있어도 여기로 온다 — 둘을 가르려면
      // 에러 코드를 올려야 하는데, BaseRepository 가 전부 null 로 삼킨다.
      throw new BadRequestException(
        `등록하지 못했다. 같은 이름이 이미 있거나(${place.canonicalName} · ${name}) DB 가 꺼져 있다`,
      );
    }
    return toResponse(row);
  }

  // ------------------------------------------------------------------ 수정
  @Patch(':id')
  @ApiOperation({
    summary: '관광지 수정',
    description:
      '**준 칸만 고친다.** 안 준 칸은 그대로다.\n\n' +
      '⚠️ `null` 은 "비움" 이라 다르다 — `area: null` 은 위치를 지우고, ' +
      '`area` 를 아예 안 주면 그대로 둔다.',
  })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateAttractionBody,
    @Headers('x-debug-token') token?: string,
  ): Promise<unknown> {
    this.authorize(token);

    // ⚠️ undefined(안 건드림)와 null(비움)을 갈라야 한다. 한데 묶으면 이름만 고치려던
    //    요청이 사진을 지운다.
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = text(body.name);
      if (!name) throw new BadRequestException('name 을 빈 값으로 바꿀 수 없다');
      patch.name = name;
    }
    if (body.nameEn !== undefined) patch.name_en = text(body.nameEn) || null;
    if (body.area !== undefined) patch.area = text(body.area) || null;
    if (body.imageUrl !== undefined) patch.image_url = this.checkedImage(body.imageUrl);
    if (body.rank !== undefined) {
      if (!Number.isFinite(body.rank)) throw new BadRequestException('rank 는 숫자여야 한다');
      patch.rank = Number(body.rank);
    }
    if (!Object.keys(patch).length) throw new BadRequestException('고칠 칸이 없다');

    const row = await this.attractions.update(id, patch);
    if (!row) throw new NotFoundException(`관광지 ${id} 를 찾을 수 없다`);
    return toResponse(row);
  }

  // ------------------------------------------------------------------ 삭제
  @Delete(':id')
  @ApiOperation({
    summary: '관광지 삭제',
    description:
      '노출 기록은 남는다 — `recommendation_item_attractions.attraction_id` 가 null 이 될 뿐이다. ' +
      '"그때 이걸 보여줬다" 를 지우면 클릭 통계가 앞뒤가 안 맞는다.',
  })
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Headers('x-debug-token') token?: string,
  ): Promise<{ deleted: number }> {
    this.authorize(token);
    const rows = await this.attractions.remove(id);
    if (rows === null) throw new BadRequestException('DB 를 쓸 수 없다');
    if (!rows.length) throw new NotFoundException(`관광지 ${id} 를 찾을 수 없다`);
    return { deleted: rows.length };
  }

  // ------------------------------------------------------------------ 정렬
  @Post('reorder')
  @ApiOperation({
    summary: '한 도시의 노출 순서를 다시 매긴다',
    description:
      '관리 화면의 드래그 정렬용이다. **배열 위치가 곧 rank 다**(0이 첫째).\n\n' +
      '한 도시의 목록을 통째로 보내는 것을 전제한다 — 일부만 보내면 보낸 것들이 ' +
      '앞으로 당겨지고 나머지 순서가 겹친다.',
  })
  async reorder(
    @Body() body: ReorderBody,
    @Headers('x-debug-token') token?: string,
  ): Promise<{ moved: number }> {
    this.authorize(token);
    const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) throw new BadRequestException('ids 가 필요하다');
    return { moved: await this.attractions.reorder(ids) };
  }

  @Post('images')
  @ApiOperation({
    summary: '한 도시에서 사진이 빈 관광지를 위키미디어로 채운다',
    description:
      '**비어 있는 칸만 채운다** — 사람이 골라 넣은 사진은 건드리지 않는다.\n\n' +
      '한국어판 → 영어판 → 위키미디어 커먼즈 순으로 찾고, 찾은 문서 주소를 ' +
      '`image_source` 에 같이 남긴다. ⚠️ 위키미디어 사진은 대부분 저작자 표시가 ' +
      '필요한 라이선스라, 그 링크가 출처를 밝힐 유일한 단서다.\n\n' +
      '⚠️ **전부 채워지지는 않는다.** 위키미디어에 사진이 없는 장소가 있다 — ' +
      '지하상가·백화점처럼 관광지로 촬영된 적 없는 곳이 특히 그렇다. ' +
      '카카오 listCard 는 이미지가 없는 줄을 사진 없이 그리므로 카드는 깨지지 않는다.\n\n' +
      '⚠️ 느리다(빈 곳 하나당 최대 3회 조회). 관리 화면에서 도시 단위로 부른다.',
  })
  @ApiResponse({ status: 201, description: '채운 수와 못 채운 수' })
  async fillImages(
    @Body() body: { city?: string },
    @Headers('x-debug-token') token?: string,
  ): Promise<{ city: string; filled: number; missing: number }> {
    this.authorize(token);
    const place = await this.resolveCity(body?.city ?? '');
    // 영어판·커먼즈 검색어에 쓸 도시명. 슬러그가 이미 영문이다 (ho-chi-minh → ho chi minh).
    const result = await this.images.fillCity(
      place.id,
      place.canonicalName,
      place.slug.replace(/-/g, ' '),
    );
    return { city: place.canonicalName, ...result };
  }

  // ------------------------------------------------------------------ 내부
  /**
   * 도시 이름 → `places` 행. 없으면 만든다.
   *
   * 검색 경로와 **같은 해석기를 쓴다.** 관리 화면에서 "오사카" 로 넣은 것과 사용자가
   * "오사카 관광지" 로 물은 것이 같은 행에 닿아야 목록이 보인다 — 여기서 갈리면
   * 등록은 되는데 카드가 비는, 원인을 찾기 어려운 상태가 된다.
   */
  private async resolveCity(raw: string) {
    const name = text(raw);
    if (!name) throw new BadRequestException('city 가 필요하다');

    const place = await this.places.resolve(name);
    if (!place) throw new BadRequestException(`도시를 알아볼 수 없다: ${raw}`);
    return place;
  }

  /**
   * 사진 주소 검사.
   *
   * ⚠️ **등록 시점에 막는다.** 카카오는 http 이미지를 조용히 안 그려서, 통과시키면
   *    운영자는 "왜 사진이 안 나오지" 를 카드를 보고서야 알게 된다.
   */
  private checkedImage(raw: string | null | undefined): string | null {
    const url = text(raw);
    if (!url) return null;
    const checked = httpsOnly(url);
    if (!checked) {
      throw new BadRequestException('imageUrl 은 https 주소여야 한다 (카카오가 http 를 막는다)');
    }
    return checked;
  }

  private authorize(token?: string): void {
    const expected = this.config.debugToken;
    if (!expected) throw new NotFoundException();
    if (!token || !safeEqual(token, expected)) throw new UnauthorizedException();
  }
}

/** DB 행 → 관리 화면이 받는 모양. snake_case 를 밖으로 내보내지 않는다. */
function toResponse(row: Record<string, any>) {
  return {
    id: row.id,
    name: row.name,
    area: row.area ?? null,
    imageUrl: row.image_url ?? null,
    rank: row.rank ?? 0,
    // 어디서 왔는지. 관리 화면이 'AI' 배지를 붙여 검수 대상을 드러낸다.
    source: row.source ?? 'manual',
  };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
