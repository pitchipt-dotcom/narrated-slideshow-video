# 台本のセグメント分割

## 実装

- 処理: `backend/manual-script-segmentation.js`
- 単体テスト: `tests/test_manual_script_segmentation.js`
- 主な関数:
 - `segmentScripts(subtitleText, speechText)`: 2種類の文字列を分割して対応付ける純粋処理。
 - `applySegmentationToJob(job)`: ジョブの複製へ分割結果を適用する。
 - `segmentAndSaveManualJob(jobId, { root })`: 明示されたジョブルートの`job.json`を原子的に更新する。

## 分割規則

優先順位は次のとおり。

1. 明示区切り行`===SEGMENT===`
2. 1行以上の空行で区切られた入力ブロック
3. 文末句読点`。`、`！`、`？`、`!`、`?`

明示区切りは両方の台本で使用し、件数を一致させる。空行ブロックがある場合は、そのブロック内を句読点でさらに分けない。これにより利用者が段落単位の対応を明示できる。

句読点は分割前のセグメントに残す。文末に続く閉じ括弧も同じセグメントへ含める。構造上の区切り行とセグメント境界の空白以外、表記、読み、句読点、内部改行を自動修正しない。`---`など表示上の区切りを含む元の`subtitle_text`と`speech_text`はここでは保持し、Irodoriへ渡す文字列だけを後段で別に正規化する。

## 対応と検証

- 両方を独立に分割し、件数が異なる場合は`SEGMENT_COUNT_MISMATCH`として保存しない。
- 明示区切りが片方だけにある場合は`DELIMITER_MISMATCH`として保存しない。
- 空セグメントは`EMPTY_SEGMENT`として拒否する。
- 一致した順番へ`seg_001`、`seg_002`の同一IDを割り当てる。
- `subtitle_text`と`speech_text`は同じsegmentオブジェクト内へ別々に保持する。
- 元全文は`input.subtitle_text`と`input.speech_text`にそのまま保持する。
- 字幕セグメントが80文字を超える場合は`LONG_SUBTITLE_SEGMENT`警告を返す。自動短縮や言い換えはしない。
- Schema上限の字幕1,000文字、読み上げ2,000文字を超えるセグメントは保存しない。

これらの分割・入力検証エラーは再実行しても解消しないため`retryable=false`とする。worker経由ではjobを`failed`へ更新し、`error.stage=segmenting`、件数と修正方法を利用者向けmessageへ保存した後、自動再試行候補から除外する。

## 保存結果

成功時は`status`と`current_stage`を`segments_ready`へ変更し、`segmenting`と`segments_ready`の履歴を追加する。各segmentの音声状態は`pending`、画像ID、表示時間、音声パス、音声時間、字幕時間は未設定のままにする。

`job.json`は同じディレクトリの一時ファイルへ完全に書いてからrenameする。分割・検証に失敗した場合は元の`job.json`を書き換えない。
