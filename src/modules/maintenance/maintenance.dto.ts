import { ApiProperty } from '@nestjs/swagger';

/**
 * 초기화 요청.
 *
 * ⚠️ **토큰만으로는 못 지우게 한다.** 토큰은 진단·관리 API 와 공유라 이미 손에 들고
 *    있는 경우가 많고, 이 경로는 되돌릴 수 없다. DB 이름을 손으로 적게 해서
 *    "다른 일 하다가 실수로" 와 "지우려고 왔다" 를 가른다 —
 *    `GET /api/v1/admin/reset` 이 그 값을 알려준다.
 */
export class ResetBody {
  @ApiProperty({
    description:
      '`MYSQL_DATABASE` 값을 그대로 적는다. 다르면 **아무것도 지우지 않고** 400 이다. ' +
      '`GET /api/v1/admin/reset` 의 `database` 가 이 값이다',
    example: 'travel',
  })
  confirm!: string;
}
