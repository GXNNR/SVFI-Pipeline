import sys
import os
import time
import subprocess

def leer_config():
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.txt")
    config = {}
    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            for linea in f:
                linea = linea.strip()
                if "=" in linea and not linea.startswith("#"):
                    key, value = linea.split("=", 1)
                    config[key.strip()] = value.strip()
    return config

CONFIG = leer_config()
RUTA_SVFI = CONFIG.get("SVFI_PATH", "")
RUTA_PRESET = CONFIG.get("PRESET_PATH", "")
CARPETA_SVFI = os.path.dirname(RUTA_SVFI) if RUTA_SVFI else ""
RUTA_FFMPEG = None

_LOG_FILE = None
if len(sys.argv) > 1:
    try:
        _LOG_FILE = open(os.path.join(sys.argv[1], "svfi_log.txt"), "w", encoding="utf-8")
    except Exception:
        pass

def log(msg):
    print(msg, flush=True)
    if _LOG_FILE:
        try:
            _LOG_FILE.write(msg + "\n")
            _LOG_FILE.flush()
        except Exception:
            pass


def esperar_archivo_estable(ruta, timeout=300):
    inicio = time.time()
    tamano_anterior = -1
    estable_desde = None
    log(f"Waiting for file: {ruta}")
    while time.time() - inicio < timeout:
        if os.path.exists(ruta):
            tamano_actual = os.path.getsize(ruta)
            if tamano_actual == tamano_anterior and tamano_actual > 0:
                if estable_desde is None:
                    estable_desde = time.time()
                elif time.time() - estable_desde > 2:
                    log(f"File stable: {tamano_actual} bytes")
                    return True
            else:
                estable_desde = None
                log(f"  Current size: {tamano_actual} bytes")
            tamano_anterior = tamano_actual
        time.sleep(1)
    log(f"TIMEOUT: File did not stabilize within {timeout}s")
    return False


def reescribir_output_dir(ruta_preset, nueva_carpeta):
    with open(ruta_preset, "r", encoding="utf-8") as f:
        lineas = f.readlines()
    nueva_ruta = nueva_carpeta.replace("/", "\\\\")
    modificado = False
    for i, linea in enumerate(lineas):
        if linea.startswith("output_dir="):
            lineas[i] = f"output_dir={nueva_ruta}\n"
            modificado = True
            log(f"output_dir rewritten to: {nueva_ruta}")
            break
    if not modificado:
        log("WARNING: output_dir was not found in the preset.")
    with open(ruta_preset, "w", encoding="utf-8") as f:
        f.writelines(lineas)


def snapshot(carpeta):
    archivos = set()
    for root, dirs, files in os.walk(carpeta):
        for f in files:
            archivos.add(os.path.join(root, f))
    return archivos


def main():
    if len(sys.argv) < 2:
        log("ERROR: Working folder argument is missing.")
        return
    if not RUTA_SVFI:
        log("ERROR: SVFI_PATH was not found in config.txt")
        return
    if not RUTA_PRESET:
        log("ERROR: PRESET_PATH was not found in config.txt")
        return

    carpeta = sys.argv[1]
    txt_entrada = os.path.join(carpeta, "ae_svfi_input.txt")
    txt_salida = os.path.join(carpeta, "svfi_output.txt")

    if not os.path.exists(txt_entrada):
        log(f"ERROR: {txt_entrada} does not exist.")
        return

    with open(txt_entrada, "r", encoding="utf-8") as f:
        nombre_archivo = f.read().strip()

    ruta_input = os.path.normpath(os.path.join(carpeta, nombre_archivo))

    log(f"Input file: {ruta_input}")
    log("Waiting for AE to finish rendering...")

    if not esperar_archivo_estable(ruta_input):
        log("ERROR: AE output file did not stabilize.")
        return

    log("File ready. Preparing SVFI...")

    reescribir_output_dir(RUTA_PRESET, carpeta)

    comando = [RUTA_SVFI, "-i", ruta_input, "--config", RUTA_PRESET, "-t", "ae_task"]

    log("COMMAND TO EXECUTE:")
    log(" ".join(f'"{c}"' if " " in c else c for c in comando))
    log("")

    entorno = os.environ.copy()
    entorno["PATH"] = CARPETA_SVFI + os.pathsep + entorno.get("PATH", "")

    if RUTA_FFMPEG:
        entorno["PATH"] = RUTA_FFMPEG + os.pathsep + entorno["PATH"]

    archivos_antes = snapshot(carpeta)

    log(f"Files before SVFI: {len(archivos_antes)}")

    try:
        resultado = subprocess.run(
            comando,
            capture_output=True,
            text=True,
            timeout=3600,
            cwd=CARPETA_SVFI,
            env=entorno
        )

        log("--- SVFI STDOUT ---")
        log(resultado.stdout if resultado.stdout else "(empty)")

        log("--- SVFI STDERR ---")
        log(resultado.stderr if resultado.stderr else "(empty)")

        log(f"Exit code: {resultado.returncode}")

    except subprocess.TimeoutExpired:
        log("ERROR: SVFI took more than 1 hour. Aborting.")
        return

    except Exception as e:
        log(f"ERROR running SVFI: {e}")
        return

    log("Waiting for SVFI to generate the final file...")

    timeout_total = 1800
    inicio_espera = time.time()
    ruta_final = None

    while time.time() - inicio_espera < timeout_total:
        archivos_ahora = snapshot(carpeta)
        nuevos = archivos_ahora - archivos_antes

        nuevos_videos = [
            f for f in nuevos
            if f.lower().endswith(('.mov', '.mp4', '.avi', '.mkv'))
        ]

        if nuevos_videos:
            candidato = max(nuevos_videos, key=os.path.getmtime)

            if os.path.exists(candidato):
                tamano1 = os.path.getsize(candidato)
                time.sleep(2)
                tamano2 = os.path.getsize(candidato)

                if tamano1 == tamano2 and tamano1 > 0:
                    ruta_final = candidato
                    log(f"New file detected!: {ruta_final}")
                    log(f"Size: {tamano1} bytes")
                    break

        log(f"  Waiting... ({int(time.time() - inicio_espera)}s)")
        time.sleep(3)

    if not ruta_final:
        log("ERROR: SVFI did not generate a new file within 30 minutes.")
        log("Files in the folder:")

        for f in os.listdir(carpeta):
            log(f"  - {f}")

        return

    with open(txt_salida, "w", encoding="utf-8") as f:
        f.write(ruta_final.replace("\\", "/"))

    log(f"Done! Result saved to: {ruta_final}")


if __name__ == "__main__":
    main()