# ジョブの音声時間取得と連結

音声一貫性改善後は、`voice_generation.profile_snapshot.tempo`があるjobではその固定値を優先する。既存jobでsnapshotがない場合だけvoice profile正本のtempoへ後方互換フォールバックする。これにより、segment生成途中にprofile正本が変わっても同じjobへ別tempoを混入させない。

生成済みWAVの実時間を取得し、voice profileのtempoを適用して順に連結する。

## 実装と処理順

- `backend/manual-audio-assembly.js`
- `tests/test_manual_audio_assembly.js`

1. ジョブが`audio_ready`で、全segmentが`generated`か確認する。
2. `order`が1から連続し、IDとWAV論理パスが一致し、全WAVがジョブの`audio/`内にあることを確認する。欠損、0 byte、WAV headerだけのファイルは連結前にエラーとして停止する。
3. 各WAVへ既存voice profileのtempoを適用し、48kHz、mono、PCM 16-bitへ揃えた一時WAVをジョブ内一時ディレクトリへ作る。
4. tempo適用後の各WAVをffprobeで実測する。任意の無音時間をsegment間へ挿入し、`order`順に連結する。
5. `segments[].audio.duration_seconds`と`timing.start_seconds`、`timing.end_seconds`へ実測値と積み上げ値を保存する。
6. 連結WAVを再度ffprobeし、積み上げ時間との差が50ms以内であることを確認して`artifacts.audio_file`へ保存する。

## 安全条件

- 既定出力はジョブ内の`audio/assembled.wav`で、既存ファイルを上書きしない。
- `.assemble.lock`を排他的に作成し、同一ジョブの二重連結を防ぐ。
- 一時ファイルは`audio/.tmp-assembly-*`だけに作り、成功・失敗を問わず除去する。
- 欠損WAV、順序不正、論理パス不一致が1件でもあれば、出力とjob.jsonを変更せず停止する。
- 出力と保存済みtimingが一致する再実行は既存WAVを再利用する。
- job.json確定前に作成した出力は、その確定が失敗した場合だけ除去する。

tempoは0.5〜2.0の範囲とし、音声生成時のprofile設定を尊重する。無音は最終再生時間として0〜10秒を明示指定でき、既定は0秒。
