param(
  [Parameter(Mandatory=$true)][ValidateSet('inspect','exportPdf')][string]$Action,
  [Parameter(Mandatory=$true)][string]$InputPath,
  [string]$OutputPath
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$extension = [IO.Path]::GetExtension($InputPath).ToLowerInvariant()
$app = $null; $doc = $null; $alreadyRunning = $false
$progId = if ($extension -in '.docx','.doc') {'Word.Application'} elseif ($extension -in '.xlsx','.xlsm','.xls') {'Excel.Application'} elseif ($extension -in '.pptx','.ppt') {'PowerPoint.Application'} elseif ($extension -in '.vsdx','.vsd') {'Visio.Application'} else {''}
if ($progId) {try {$active=[Runtime.InteropServices.Marshal]::GetActiveObject($progId); $alreadyRunning=$true; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($active)} catch {}}
try {
  switch ($extension) {
    { $_ -in '.docx','.doc' } {
      $kind='word'; $app=New-Object -ComObject Word.Application
      $app.Visible=$false; $app.DisplayAlerts=0; $app.AutomationSecurity=3
      $doc=$app.Documents.Open($InputPath,$false,$true)
      if ($Action -eq 'inspect') {
        $items=@(); foreach($p in $doc.Paragraphs){$t=$p.Range.Text.Trim(); if($t){$items+=@{text=$t.Substring(0,[Math]::Min(150,$t.Length));style=[string]$p.Style.NameLocal}; if($items.Count -ge 30){break}}}
        $result=@{kind=$kind;paragraphs=$doc.Paragraphs.Count;tables=$doc.Tables.Count;sample=$items}
      } else {$doc.ExportAsFixedFormat($OutputPath,17); $result=@{kind=$kind;output=$OutputPath}}
    }
    { $_ -in '.xlsx','.xlsm','.xls' } {
      $kind='excel'; $app=New-Object -ComObject Excel.Application
      $app.Visible=$false; $app.DisplayAlerts=$false; $app.AutomationSecurity=3
      $doc=$app.Workbooks.Open($InputPath,0,$true)
      if ($Action -eq 'inspect') {
        $sheets=@(); foreach($sheet in $doc.Worksheets){$sheets+=@{name=$sheet.Name;rows=$sheet.UsedRange.Rows.Count;columns=$sheet.UsedRange.Columns.Count;charts=$sheet.ChartObjects().Count}}
        $result=@{kind=$kind;sheets=$sheets}
      } else {$doc.ExportAsFixedFormat(0,$OutputPath); try {$app.CutCopyMode=0} catch {}; $result=@{kind=$kind;output=$OutputPath}}
    }
    { $_ -in '.pptx','.ppt' } {
      $kind='powerpoint'; $app=New-Object -ComObject PowerPoint.Application
      $app.AutomationSecurity=3
      $doc=$app.Presentations.Open($InputPath,$true,$false,$false)
      if ($Action -eq 'inspect') {
        $slides=@(); foreach($slide in $doc.Slides){$texts=@();foreach($shape in $slide.Shapes){if($shape.HasTextFrame -and $shape.TextFrame.HasText){$texts+= [string]$shape.TextFrame.TextRange.Text}};$slides+=@{index=$slide.SlideIndex;shapes=$slide.Shapes.Count;text=($texts -join ' ').Substring(0,[Math]::Min(240,($texts -join ' ').Length))}}
        $result=@{kind=$kind;slides=$slides;count=$doc.Slides.Count}
      } else {$doc.SaveAs($OutputPath,32); $result=@{kind=$kind;output=$OutputPath}}
    }
    { $_ -in '.vsdx','.vsd' } {
      $kind='visio'; $app=New-Object -ComObject Visio.Application
      $app.Visible=$false
      $doc=$app.Documents.OpenEx($InputPath,2)
      if ($Action -eq 'inspect') {
        $pages=@(); foreach($page in $doc.Pages){$pages+=@{name=$page.Name;shapes=$page.Shapes.Count}}
        $result=@{kind=$kind;pages=$pages}
      } else {$doc.ExportAsFixedFormat(1,$OutputPath,0,0); $result=@{kind=$kind;output=$OutputPath}}
    }
    default { throw 'Unsupported Office file extension.' }
  }
  $result | ConvertTo-Json -Depth 7 -Compress
} finally {
  if ($doc) {try {if($kind -eq 'word'){$doc.Close(0)} elseif($kind -eq 'excel'){$doc.Close($false)} else {$doc.Close()}} catch{};[void][Runtime.InteropServices.Marshal]::ReleaseComObject($doc)}
  if ($app) {if (-not $alreadyRunning) {try {$app.Quit()} catch{}};[void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)}
  [GC]::Collect();[GC]::WaitForPendingFinalizers()
}
