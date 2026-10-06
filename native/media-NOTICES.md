# Componentes de mídia

FFmpeg e ffprobe 6.1.1 são programas independentes executados sem shell. Binários: <https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1>. Os arquivos FFMPEG-LICENSE e FFMPEG-README distribuídos junto aos executáveis contêm licença GPL, configuração e origem dos builds. Código-fonte FFmpeg: <https://ffmpeg.org/releases/ffmpeg-6.1.1.tar.xz>; scripts de build e referências de fontes: <https://github.com/eugeneware/ffmpeg-static/tree/b6.1.1>.

whisper.cpp 1.8.2 é compilado a partir de <https://github.com/ggml-org/whisper.cpp/tree/v1.8.2> pelo script versionado `scripts/prepare-media.mjs`, somente CPU, sem download em tempo de execução. Licença MIT em WHISPER-LICENSE. Modelo Whisper base multilíngue (MIT): <https://huggingface.co/ggerganov/whisper.cpp>; origem e licença: <https://github.com/openai/whisper>.

URLs, versões e SHA-256 estão fixados em `native/media-lock.json`. O instalador inclui as ferramentas e os pesos. O STAG não requer Python, FFmpeg instalado no computador nem uma chave de API de transcrição. A transcrição automática pode conter erros; ela não comprova fatos do projeto.
