# Irodori音声ブロック

字幕区間とIrodoriへの音声生成リクエストを分離する。字幕は従来の短い
`segments`を維持し、音声は複数字幕をまとめた`audio_blocks`単位で生成する。
`audio_blocks`を持たない既存ジョブは従来の字幕セグメント単位で処理する。

## 設定

```env
TTS_BLOCK_TARGET_CHARS=100
TTS_BLOCK_MAX_CHARS=160
TTS_BLOCK_MIN_CHARS=40
TTS_BLOCK_MAX_SENTENCES=4
SUBTITLE_MIN_DURATION_SEC=1.2
SUBTITLE_MAX_DURATION_SEC=6.0
SUBTITLE_GAP_SEC=0.05
```

音声ブロックは句点などの文末を尊重して字幕を順番に結合する。空行や読点だけでは
分割せず、最大4文・160文字を上限とする。短い末尾ブロックは、上限内なら直前の
ブロックへ統合する。

## 字幕同期

生成後に測定したブロック音声尺を、対応字幕の読み上げ文字数に比例して配分する。
句読点、括弧、記号、空白、改行は文字数の重みから除外する。各字幕へ既定1.2秒以上、
6.0秒以下、字幕間0.05秒を可読性の目安として使う。ブロック実尺が目安の容量外でも
停止せず、常に文字数比で全実尺を配分する。最小時間を確保できない場合はgapを0にし、
それでも不足すれば最小時間を緩和する。最大時間を超える場合はブロック終端まで字幕を
延長する。緩和したブロックはworker警告ログとjob historyへ記録する。字幕本文と最大2行
の整形処理は従来のまま維持する。

## 再生成と互換性

- 新形式は失敗または品質異常の`audio_block_id`だけを再生成し、正常ブロックをコピーして再利用する。
- seedと音声プロファイルは動画全体で共通とし、従来の固定seed仕様を維持する。
- 旧形式（`audio_blocks`なし）は従来の`segment_id`単位の生成、品質確認、再生成を使う。
- 進捗APIは新形式でブロック進捗、全字幕数、処理中の字幕範囲を返し、旧形式の表示も維持する。

## 回帰確認

```bash
node tests/test_manual_audio_blocks.js
node tests/test_manual_audio_block_generation.js
node tests/test_manual_script_segmentation.js
node tests/test_manual_segment_audio_generation.js
node tests/test_manual_audio_quality.js
node tests/test_manual_audio_assembly.js
node tests/test_manual_subtitle_generation.js
node tests/test_manual_job_worker.js
node tests/test_manual_job_status.js
node tests/test_manual_job_regeneration.js
```

長文確認では、字幕数、音声ブロック数、ブロック音声の実測尺、SRT終端、完成動画尺、
品質異常の有無を確認する。部分再生成では対象ブロックだけがpendingとなり、正常な
ブロックのWAVが再利用されることを確認する。
