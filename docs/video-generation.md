# ジョブのFFmpeg動画生成

`images_ready`のjobについて、指定順の画像、連結WAV、UTF-8 SRTからMP4を生成する。

## 出力の仕様

- 3:2は768x512。
- 画像は縦横比を維持してscaleし、余白pad、SAR 1。
- 入力画像はジョブ一時ディレクトリへコピー後、各画像を個別に出力解像度・SAR 1のPNGへ正規化してからconcatする。横長・縦長など入力解像度が切り替わっても映像filterの時系列状態を再初期化させない。
- SRTはlibassで映像へ焼き付ける。
- 映像H.264 high/yuv420p/30fps、音声AAC 192kbps、`faststart`付きMP4。
- concat画像は疎なPTSを持つため、30fps化は出力オプション`-r`ではなく`fps=30`映像フィルタで行う。global `-t`はconcat終端packetを読む前に停止する境界条件があるため使用しない。入力を終端まで読んだうえで、映像は`tpad=stop_mode=clone`と`trim`、音声は`atrim`を使い、連結WAVの同じ実測尺へ個別に揃える。短いstreamへ全出力を合わせる`-shortest`も使用しない。
- 画像時間はjobの`order`と`duration_seconds`を使用し、最終音声尺と50ms以内で一致させる。

追加比率は16:9=1280x720、9:16=720x1280、1:1=720x720とする。

## パス・保存・エラー

入力論理パスは呼出元が明示したlogical→host mapping内だけを実在パスへ解決する。入力はジョブ内一時ディレクトリへ安全名でコピーし、concatリストへ利用者ファイル名を直接書かない。

出力は`video/<安全名>.mp4`へ非上書きで確定し、ffprobeでH.264、AAC、解像度、30fps、yuv420pを確認する。container、映像stream、音声streamの各durationを連結WAVと個別比較し、すべて尺差100ms以内の場合だけ`video_ready`と`artifacts.video_file`を保存する。成功済み出力は再利用する。

画像timelineと連結WAVの生成前許容差は50ms、生成後の各MP4 durationと連結WAVの許容差は100msとする。短い末尾丸めやAAC/frame境界差は許容するが、許容差を超える末尾欠落は正常扱いしない。検証失敗messageには不一致項目、期待値、実測値、差、許容差を保存し、同じ入力での自動再試行は行わない。

FFmpeg開始後の失敗はjobを`failed`へし、`error.stage=video_generating`、短いcode/message、再試行可否を保存する。中間MP4とジョブ内一時ディレクトリは除去し、原画像、音声、字幕を変更しない。
