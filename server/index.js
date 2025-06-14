require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const categorias = require("./data/categorias.json");
const levenshtein = require("fast-levenshtein");

const PORT = process.env.PORT || 3000;
const MAX_JOGADORES = 10;
const INATIVIDADE_MS = 5 * 60 * 1000; // 5 minutos
const MAX_RODADAS = 10;
const DELAY_REINICIO = 15000; // 10 segundos
const DELAY_PROXIMA_RODADA = 5000; // 2 segundos entre rodadas
const BLOQUEIO_CATEGORIA_MS = 2 * 60 * 60 * 1000; // 2 horas em ms
const TEMPO_RODADA_MS = 90000; // 90 segundos

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(express.static("client/dist"));
app.get(/^\/(?!socket\.io).*/, (req, res) => {
  res.sendFile("client/dist/index.html", { root: "." });
});
app.use(cors());
app.use(express.json());

let salas = {};

function normalizarTexto(texto) {
  return texto
    .toLowerCase()
    .normalize("NFD") // separa os acentos
    .replace(/[\u0300-\u036f]/g, "") // remove os acentos
    .replace(/[ç]/g, "c") // substitui cedilha
    .replace(/[^a-z0-9\s]/g, "") // remove caracteres especiais
    .replace(/-/g, " ") // substitui hífens por espaço
    .replace(/'/g, " ") // substitui apóstrofos por espaço
    .replace(/\s+/g, " ") // reduz múltiplos espaços
    .trim(); // remove espaços nas pontas
}

function sortearPalavras(categoria) {
  const palavras = [...categorias[categoria]];
  const sorteadas = [];
  while (sorteadas.length < 10 && palavras.length > 0) {
    const index = Math.floor(Math.random() * palavras.length);
    sorteadas.push(palavras.splice(index, 1)[0]);
  }

  return sorteadas;
}

function identificarVencedores(sala) {
  let maxPontos = -1;
  let vencedores = [];

  // Encontra maior pontuação
  for (const usuario of Object.values(sala.usuarios)) {
    if (usuario.pontos > maxPontos) {
      maxPontos = usuario.pontos;
    }
  }

  // Encontra todos que têm a pontuação máxima (empate)
  for (const [id, usuario] of Object.entries(sala.usuarios)) {
    if (usuario.pontos === maxPontos) {
      vencedores.push(id);
    }
  }

  return vencedores; // retorna lista de IDs dos vencedores
}

function enviarPlacarFinal(salaId) {
  const sala = salas[salaId];
  if (!sala) return;
  const ranking = Object.values(sala.usuarios)
    .sort((a, b) => b.pontos - a.pontos)
    .slice(0, 3);

  io.to(salaId).emit("fimDeJogo", { ranking });
}

function enviarRankingVitorias(salaId) {
  const sala = salas[salaId];
  if (!sala) return;

  const ranking = Object.entries(sala.usuarios)
    .map(([id, usuario]) => ({
      id,
      nome: usuario.nome,
      vitorias: usuario.vitorias || 0,
      pontos: usuario.pontos || 0,
    }))
    .filter((jogador) => jogador.vitorias > 0 && jogador.pontos > 0)
    .sort((a, b) => b.vitorias - a.vitorias)
    .slice(0, 5);

  io.to(salaId).emit("atualizarRanking", ranking);
}

function reiniciarPartida(salaId) {
  const sala = salas[salaId];
  if (!sala) return;
  sala.rodada = 0;
  sala.acertadas = [];
  sala.respostas = [];
  sala.categoria = null;
  Object.values(sala.usuarios).forEach((u) => (u.pontos = 0));
  io.to(salaId).emit("mensagem", {
    nome: "Sistema",
    texto: "Reiniciando partida em breve...",
    acertou: false,
  });
  io.to(salaId).emit("estadoJogo", { emJogo: true });
  sala.aceitandoAcertos = false;
  setTimeout(() => iniciarNovaRodada(salaId), DELAY_REINICIO);
}

function definirVencedorSeNecessario(sala) {
  if (!sala.vencedorDefinido) {
    const vencedores = identificarVencedores(sala);
    for (const vencedorId of vencedores) {
      sala.usuarios[vencedorId].vitorias = (sala.usuarios[vencedorId].vitorias || 0) + 1;
    }
    sala.vencedorDefinido = true;
  }
}

function iniciarNovaRodada(salaId) {
  const sala = salas[salaId];
  if (!sala) return;

  sala.rodada++;

  if (sala.rodada > MAX_RODADAS) {
    enviarPlacarFinal(salaId);
    io.to(salaId).emit("mensagem", {
      nome: "Sistema",
      texto: "Partida finalizada! Iniciando nova partida...",
      tipo: "info",
      acertou: false,
    });

    definirVencedorSeNecessario(sala);
    enviarRankingVitorias(salaId);

    io.to(salaId).emit("estadoJogo", { emJogo: true });
    sala.aceitandoAcertos = false;

    setTimeout(() => {
      reiniciarPartida(salaId);
    }, DELAY_REINICIO);

    return;
  }

  sala.aceitandoAcertos = true;
  sala.vencedorDefinido = false;

  const agora = Date.now();

  let categoriasDisponiveis = Object.keys(categorias).filter((cat) => {
    const usadoEm = sala.jaUsadas[cat];
    return !usadoEm || agora - usadoEm > BLOQUEIO_CATEGORIA_MS;
  });

  if (categoriasDisponiveis.length === 0) {
    console.log(`Sala ${salaId} - Todas as categorias estavam bloqueadas, resetando jaUsadas.`);
    sala.jaUsadas = {};
    categoriasDisponiveis = Object.keys(categorias);
  }

  const novaCategoria = categoriasDisponiveis[Math.floor(Math.random() * categoriasDisponiveis.length)];

  sala.categoria = novaCategoria;
  sala.respostas = sortearPalavras(novaCategoria);
  sala.acertadas = [];
  sala.jaUsadas[novaCategoria] = agora;
  sala.fimDaRodada = agora + TEMPO_RODADA_MS;
  sala.inicioRodada = agora;

  io.to(salaId).emit("dadosSala", {
    categoria: sala.categoria,
    acertadas: sala.acertadas,
    rodada: sala.rodada,
  });

  io.to(salaId).emit("mensagem", {
    nome: "Sistema",
    texto: `Rodada ${sala.rodada}/10 começou!`,
    acertou: false,
  });
  io.to(salaId).emit("mensagem", {
    nome: "Sistema",
    texto: `Nova categoria: ${sala.categoria}.`,
    acertou: false,
  });
  io.to(salaId).emit("mensagem", {
    nome: "Sistema",
    texto: `Você tem ${TEMPO_RODADA_MS / 1000} segundos para acertar as palavras.`,
    acertou: false,
  });

  if (sala.timer) clearTimeout(sala.timer);
  if (sala.metadeTempoAviso) clearTimeout(sala.metadeTempoAviso);
  if (sala.dezSegundosAviso) clearTimeout(sala.dezSegundosAviso);

  sala.metadeTempoAviso = setTimeout(() => {
    io.to(salaId).emit("mensagem", {
      nome: "Sistema",
      texto: `Metade do tempo! Faltam ${TEMPO_RODADA_MS / 2000} segundos.`,
      acertou: false,
    });
  }, TEMPO_RODADA_MS / 2);

  sala.dezSegundosAviso = setTimeout(() => {
    io.to(salaId).emit("mensagem", {
      nome: "Sistema",
      texto: `Atenção! Só restam 10 segundos!`,
      acertou: false,
    });
  }, TEMPO_RODADA_MS - 10000);

  sala.timer = setTimeout(() => {
    io.to(salaId).emit("mensagem", {
      nome: "Sistema",
      texto: "Tempo esgotado! Preparando nova rodada...",
      tipo: "info",
      acertou: false,
    });

    sala.aceitandoAcertos = false;

    setTimeout(() => {
      iniciarNovaRodada(salaId);
    }, DELAY_PROXIMA_RODADA);
  }, TEMPO_RODADA_MS);
}

function avaliarChute(chute, respostasCorretas, acertadas) {
  const chuteNorm = normalizarTexto(chute);
  for (const resposta of respostasCorretas) {
    const respNorm = normalizarTexto(resposta);
    if (acertadas.some((a) => normalizarTexto(a) === respNorm)) continue;
    if (respNorm === chuteNorm) return { acertou: true, respostaCorreta: resposta };

    // só para feedback "está perto", sem considerar acerto
    const distancia = levenshtein.get(chuteNorm, respNorm);
    const maiorTamanho = Math.max(chuteNorm.length, respNorm.length);
    const similaridade = 1 - distancia / maiorTamanho;
    if ((respNorm.includes(chuteNorm) || chuteNorm.includes(respNorm)) && chuteNorm.length >= 4) {
      return { acertou: false, perto: true, respostaPerto: resposta };
    }
    if (similaridade >= 0.85) {
      return { acertou: false, perto: true, respostaPerto: resposta };
    }
  }
  return { acertou: false, perto: false };
}

function removerInativos() {
  const agora = Date.now();
  for (const salaId in salas) {
    const sala = salas[salaId];
    let mudou = false;
    for (const socketId in sala.usuarios) {
      const usuario = sala.usuarios[socketId];
      if (agora - usuario.ultimoAtivo > INATIVIDADE_MS) {
        delete sala.usuarios[socketId];

        io.to(salaId).emit("mensagem", {
          nome: "Sistema",
          texto: `${usuario.nome} foi removido por inatividade.`,
          acertou: false,
        });

        io.to(socketId).emit("removidoInatividade");

        mudou = true;
      }
    }
    if (mudou) {
      io.to(salaId).emit("usuariosAtualizados", sala.usuarios);
      if (Object.keys(sala.usuarios).length === 0) {
        clearTimeout(sala.timer);
        clearTimeout(sala.metadeTempoAviso);
        clearTimeout(sala.dezSegundosAviso);
        delete salas[salaId];
      }
    }
  }
}
setInterval(removerInativos, 60000);

io.on("connection", (socket) => {
  socket.on("entrarSala", ({ salaId, nome }) => {
    if (!nome || !salaId) return;
    if (!salas[salaId]) {
      socket.salaId = salaId;
      const categoriasDisponiveis = Object.keys(categorias);
      const categoriaInicial = categoriasDisponiveis[Math.floor(Math.random() * categoriasDisponiveis.length)];
      salas[salaId] = {
        usuarios: {},
        categoria: categoriaInicial,
        respostas: sortearPalavras(categoriaInicial),
        acertadas: [],
        jaUsadas: { [categoriaInicial]: Date.now() },
        timer: null,
        metadeTempoAviso: null,
        dezSegundosAviso: null,
        fimDaRodada: null,
        rodada: 0,
      };
      iniciarNovaRodada(salaId);
    }

    const sala = salas[salaId];
    if (Object.keys(sala.usuarios).length >= MAX_JOGADORES) {
      socket.emit("mensagem", {
        nome: "Sistema",
        texto: `Sala cheia. Limite de ${MAX_JOGADORES} jogadores.`,
        acertou: false,
      });
      return;
    }
    // Inicializa vitórias junto com pontos (se quiser manter pontos, pode manter também)
    sala.usuarios[socket.id] = { nome, pontos: 0, vitorias: 0, ultimoAtivo: Date.now() };
    socket.join(salaId);
    socket.emit("dadosSala", {
      categoria: sala.categoria,
      acertadas: sala.acertadas,
      rodada: sala.rodada,
    });
    const tempoRestante = Math.max(0, Math.floor((sala.fimDaRodada - Date.now()) / 1000));
    socket.emit("mensagem", {
      nome: "Sistema",
      texto: `Rodada ${sala.rodada}/10 em andamento!`,
      acertou: false,
    });
    socket.emit("mensagem", {
      nome: "Sistema",
      texto: `Categoria: ${sala.categoria}`,
      acertou: false,
    });
    socket.emit("mensagem", {
      nome: "Sistema",
      texto: `Você tem ${tempoRestante} segundos restantes nesta rodada.`,
      acertou: false,
    });
    io.to(salaId).emit("usuariosAtualizados", sala.usuarios);

    // Envia ranking atualizado quando um jogador entra
    enviarRankingVitorias(salaId);
  });

  socket.on("chutar", ({ salaId, chute }) => {
    const sala = salas[salaId];
    if (!sala || !sala.usuarios[socket.id]) return;
    sala.usuarios[socket.id].ultimoAtivo = Date.now();

    const resultado = avaliarChute(chute, sala.respostas, sala.acertadas);

    if (resultado.acertou && sala.aceitandoAcertos) {
      const palavraLower = resultado.respostaCorreta.toLowerCase();
      const usuario = sala.usuarios[socket.id];

      if (!sala.acertadas.includes(palavraLower)) {
        sala.acertadas.push(palavraLower);

        if (sala.acertadas.length === 1) {
          usuario.pontos += 2; // 2 pontos pra primeira palavra
        } else {
          usuario.pontos += 1; // 1 ponto para as próximas
        }

        io.to(salaId).emit("acerto", {
          nome: usuario.nome,
          palavra: resultado.respostaCorreta,
          acertadas: sala.acertadas,
          rodada: sala.rodada,
        });

        io.to(salaId).emit("atualizarAcertadas", sala.acertadas);
        io.to(salaId).emit("usuariosAtualizados", sala.usuarios);

        if (sala.acertadas.length === 5) {
          // Impede que avisos futuros sejam enviados
          clearTimeout(sala.timer);
          clearTimeout(sala.metadeTempoAviso);
          clearTimeout(sala.dezSegundosAviso);

          sala.aceitandoAcertos = false;

          if (sala.rodada > MAX_RODADAS) {
            io.to(salaId).emit("mensagem", {
              nome: "Sistema",
              texto: "Partida finalizada! Iniciando nova partida...",
              tipo: "info",
              acertou: false,
            });

            io.to(salaId).emit("estadoJogo", { emJogo: true });
            sala.aceitandoAcertos = false;

            setTimeout(() => {
              reiniciarPartida(salaId);
            }, DELAY_REINICIO);
          } else {
            setTimeout(() => {
              io.to(salaId).emit("mensagem", {
                nome: "Sistema",
                texto: "Todas as respostas foram descobertas!",
                tipo: "info",
                acertou: false,
              });
              io.to(salaId).emit("mensagem", {
                nome: "Sistema",
                texto: "Preparando nova rodada...",
                tipo: "info",
                acertou: false,
              });
            }, 100);

            setTimeout(() => {
              iniciarNovaRodada(salaId);
            }, DELAY_PROXIMA_RODADA);
          }
        }
      }

      const tempoResposta = Math.floor((Date.now() - (sala.inicioRodada || sala.fimDaRodada - TEMPO_RODADA_MS)) / 1000);

      io.to(salaId).emit("mensagem", {
        nome: usuario.nome,
        texto: ` acertei "${resultado.respostaCorreta}" em ${tempoResposta}s`,
        acertou: true,
      });
    } else if (resultado.perto) {
      socket.emit("mensagem", {
        nome: "Sistema",
        texto: `${chute} está perto!`,
        acertou: false,
      });
    } else {
      io.to(salaId).emit("mensagem", {
        nome: sala.usuarios[socket.id].nome,
        texto: chute,
        acertou: false,
      });
    }
  });

  socket.on("disconnect", () => {
    for (const salaId in salas) {
      const sala = salas[salaId];
      if (sala.usuarios[socket.id]) {
        delete sala.usuarios[socket.id];
        io.to(salaId).emit("usuariosAtualizados", sala.usuarios);
        if (Object.keys(sala.usuarios).length === 0) {
          clearTimeout(sala.timer);
          clearTimeout(sala.metadeTempoAviso);
          clearTimeout(sala.dezSegundosAviso);
          delete salas[salaId];
        }
      }
    }
  });
});

app.get("/categorias", (req, res) => {
  res.json(Object.keys(categorias));
});

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
