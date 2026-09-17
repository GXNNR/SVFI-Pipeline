Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

strScriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
strCarpetaFile = strScriptDir & "\carpeta_actual.txt"

If Not fso.FileExists(strCarpetaFile) Then
    WScript.Quit 1
End If

Set f = fso.OpenTextFile(strCarpetaFile, 1)
carpeta = f.ReadAll
f.Close
carpeta = Trim(carpeta)

strPython = "C:\Users\User\AppData\Local\Microsoft\WindowsApps\pythonw.exe"
strScript = strScriptDir & "\svfi_orquestador.py"

comando = """" & strPython & """ """ & strScript & """ """ & carpeta & """"
shell.Run comando, 0, False
