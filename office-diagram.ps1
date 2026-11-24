param([string]$InputPath,[string]$OutputPath,[string]$SpecPath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$spec=Get-Content -LiteralPath $SpecPath -Raw -Encoding UTF8 | ConvertFrom-Json
if($spec.steps.Count -lt 2 -or $spec.steps.Count -gt 6){throw 'Expected 2 to 6 steps.'}
$app=$null;$deck=$null
try {
  $app=New-Object -ComObject PowerPoint.Application
  $app.AutomationSecurity=3
  $deck=$app.Presentations.Open($InputPath,$true,$false,$false)
  $deck.SaveCopyAs($OutputPath)
  $deck.Close();[void][Runtime.InteropServices.Marshal]::ReleaseComObject($deck)
  $deck=$app.Presentations.Open($OutputPath,$false,$false,$false)
  $slide=$deck.Slides.Add($deck.Slides.Count+1,12)
  $w=[double]$deck.PageSetup.SlideWidth;$h=[double]$deck.PageSetup.SlideHeight
  $navy=42+58*256+91*65536;$blue=70+110*256+210*65536;$light=241+246*256+253*65536
  $title=$slide.Shapes.AddTextbox(1,$w*.07,$h*.08,$w*.86,$h*.12)
  $title.TextFrame.TextRange.Text=[string]$spec.title
  $title.TextFrame.TextRange.Font.Name='Microsoft YaHei'
  $title.TextFrame.TextRange.Font.Size=27
  $title.TextFrame.TextRange.Font.Bold=-1
  $title.TextFrame.TextRange.Font.Color.RGB=$navy
  $bar=$slide.Shapes.AddShape(1,$w*.07,$h*.225,$w*.08,4);$bar.Fill.ForeColor.RGB=$blue;$bar.Line.Visible=0
  $count=$spec.steps.Count;$gap=$w*.027;$left=$w*.07;$available=$w*.86
  $cardW=($available-($count-1)*$gap)/$count
  for($i=0;$i -lt $count;$i++){
    $x=$left+$i*($cardW+$gap);$y=$h*.38;$cardH=$h*.33
    $card=$slide.Shapes.AddShape(5,$x,$y,$cardW,$cardH)
    $card.Fill.ForeColor.RGB=$light;$card.Line.ForeColor.RGB=$blue;$card.Line.Weight=1
    $card.TextFrame.MarginLeft=9;$card.TextFrame.MarginRight=9
    $card.TextFrame.VerticalAnchor=3
    $card.TextFrame.TextRange.Text=('{0:D2}  {1}' -f ($i+1),[string]$spec.steps[$i])
    $card.TextFrame.TextRange.Font.Name='Microsoft YaHei'
    $card.TextFrame.TextRange.Font.Size= if($count -ge 5){14}else{17}
    $card.TextFrame.TextRange.Font.Color.RGB=$navy
    $card.TextFrame.TextRange.ParagraphFormat.Alignment=2
    if($i -gt 0){
      $line=$slide.Shapes.AddConnector(1,$x-$gap+3,$y+$cardH/2,$x-3,$y+$cardH/2)
      $line.Line.ForeColor.RGB=$blue;$line.Line.Weight=2;$line.Line.EndArrowheadStyle=3
    }
  }
  $deck.Save()
  @{output=$OutputPath;slideCount=$deck.Slides.Count} | ConvertTo-Json -Compress
} finally {
  if($deck){try{$deck.Close()}catch{};[void][Runtime.InteropServices.Marshal]::ReleaseComObject($deck)}
  if($app){try{$app.Quit()}catch{};[void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)}
}
