import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * 관리 화면이 주고받는 모양.
 *
 * **카드에 찍히는 값이 전부 여기 있다.** 평점·카테고리·입장료 칸이 없는 게 이
 * 도메인의 정체다 — 전부 남의 콘텐츠였고, 0009 에서 같이 걷어냈다.
 */

export class AttractionBody {
  @ApiPropertyOptional({
    description: '관광지 이름. 카드 제목에 그대로 나간다. PATCH 에서는 생략 가능',
    example: '오사카성',
  })
  name?: string;

  @ApiPropertyOptional({
    description:
      '도시 안에서의 위치. 카드 설명 한 줄이 이 값이다. ' +
      '⚠️ 도시 이름을 다시 쓰지 않는다 — 사용자는 이미 그 도시를 물어봤다',
    example: '주오구',
    nullable: true,
  })
  area?: string | null;

  @ApiPropertyOptional({
    description: '카드 썸네일. **https 여야 한다** — 카카오는 http 이미지를 그리지 않는다',
    example: 'https://example.com/osaka-castle.jpg',
    nullable: true,
  })
  imageUrl?: string | null;

  @ApiPropertyOptional({
    description: '노출 순서(0이 첫째). 빼면 목록 맨 뒤로 간다',
    example: 0,
  })
  rank?: number;
}

export class CreateAttractionBody extends AttractionBody {
  @ApiProperty({ description: '관광지 이름. 등록할 때는 필수다', example: '오사카성' })
  declare name: string;

  @ApiProperty({
    description:
      '도시 이름. 사전 표기·별칭·영문 슬러그 아무거나 된다 (오사카 / osaka / 오오사카). ' +
      '사전에 없는 지명이면 모델이 정규화해 새로 등록한다',
    example: '오사카',
  })
  city!: string;
}

/** PATCH 는 준 칸만 고친다. 안 준 칸은 그대로다 — null 은 "비움" 이라 다르다. */
export class UpdateAttractionBody extends AttractionBody {}

export class ReorderBody {
  @ApiProperty({
    description:
      '관광지 id 를 원하는 순서대로. 배열 위치가 곧 rank 다(0이 첫째). ' +
      '목록에 없는 id 는 순서가 그대로 남는다',
    example: [12, 9, 31],
    type: [Number],
  })
  ids!: number[];
}
