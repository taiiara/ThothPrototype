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
const DELAY_REINICIO = 10000; // 10 segundos
const DELAY_PROXIMA_RODADA = 2000; // 2 segundos entre rodadas

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
    .replace(/ç/g, "c")
    .replace(/[^a-z0-9\s]/g, "") // remove caracteres especiais (não letras/números/espaco)
    .replace(/\s+/g, " ") // reduz espaços múltiplos a 1
    .trim();
}

function sortearPalavras(categoria) {
  const palavras = [...categorias[categoria]];
  const sorteadas = [];
  while (sorteadas.length < 5 && palavras.length > 0) {
    const index = Math.floor(Math.random() * palavras.length);
    sorteadas.push(palavras.splice(index, 1)[0]);
  }
  return sorteadas;
}

function enviarPlacarFinal(salaId) {
  const sala = salas[salaId];
  if (!sala) return;
  const ranking = Object.values(sala.usuarios)
    .sort((a, b) => b.pontos - a.pontos)
    .slice(0, 3);
  io.to(salaId).emit("fimDeJogo", {
    mensagem: "Fim de jogo! Top 3 jogadores:",
    ranking,
  });
}

function reiniciarPartida(salaId) {
  const sala = salas[salaId];
  if (!sala) return;
  sala.rodada = 1;
  sala.jaUsadas = [];
  sala.acertadas = [];
  sala.respostas = [];
  sala.categoria = null;
  Object.values(sala.usuarios).forEach((u) => (u.pontos = 0));
  io.to(salaId).emit("mensagem", {
    nome: "Sistema",
    texto: "Reiniciando partida em breve...",
    acertou: false,
  });
  setTimeout(() => iniciarNovaRodada(salaId), DELAY_REINICIO);
}

function iniciarNovaRodada(salaId) {
  const sala = salas[salaId];
  if (!sala) return;

  let categoriasDisponiveis = Object.keys(categorias).filter((cat) => !sala.jaUsadas.includes(cat));
  if (categoriasDisponiveis.length === 0) {
    sala.jaUsadas = [];
    categoriasDisponiveis = Object.keys(categorias);
  }
  const novaCategoria = categoriasDisponiveis[Math.floor(Math.random() * categoriasDisponiveis.length)];
  sala.categoria = novaCategoria;
  sala.respostas = sortearPalavras(novaCategoria);
  sala.acertadas = [];
  sala.jaUsadas.push(novaCategoria);
  sala.fimDaRodada = Date.now() + 90000;

  io.to(salaId).emit("dadosSala", {
    categoria: sala.categoria,
    acertadas: sala.acertadas,
    rodada: sala.rodada,
  });

  io.to(salaId).emit("mensagem", {
    nome: "Sistema",
    texto: `Rodada ${sala.rodada} iniciada! Você tem 90 segundos para acertar as palavras.`,
    acertou: false,
  });

  if (sala.timer) clearTimeout(sala.timer);
  if (sala.metadeTempoAviso) clearTimeout(sala.metadeTempoAviso);
  if (sala.dezSegundosAviso) clearTimeout(sala.dezSegundosAviso);

  sala.metadeTempoAviso = setTimeout(() => {
    io.to(salaId).emit("mensagem", {
      nome: "Sistema",
      texto: "Metade do tempo! Faltam 45 segundos.",
      acertou: false,
    });
  }, 45000);

  sala.dezSegundosAviso = setTimeout(() => {
    io.to(salaId).emit("mensagem", {
      nome: "Sistema",
      texto: "Atenção! Só restam 10 segundos!",
      acertou: false,
    });
  }, 80000);

  sala.timer = setTimeout(() => {
    sala.rodada++;

    if (sala.rodada > MAX_RODADAS) {
      // Fim do jogo - enviar mensagem e reiniciar partida com delay maior
      enviarPlacarFinal(salaId);
      io.to(salaId).emit("mensagem", {
        nome: "Sistema",
        texto: "Rodada finalizada! Iniciando nova partida em 10 segundos...",
        tipo: "info",
        acertou: false,
      });
      setTimeout(() => {
        reiniciarPartida(salaId);
      }, DELAY_REINICIO); // 10s
    } else {
      // Entre rodadas, delay curto para próxima rodada
      setTimeout(() => {
        io.to(salaId).emit("mensagem", {
          nome: "Sistema",
          texto: "O tempo esgotou! Preparando nova rodada...",
          tipo: "info",
          acertou: false,
        });
      }, 100); // 100ms de atraso

      setTimeout(() => {
        iniciarNovaRodada(salaId);
      }, DELAY_PROXIMA_RODADA); // 2s
    }
  }, 90000);
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

        // mensagem para todos da sala
        io.to(salaId).emit("mensagem", {
          nome: "Sistema",
          texto: `${usuario.nome} foi removido por inatividade.`,
          acertou: false,
        });

        // aviso só para o usuário removido pra ele ser redirecionado
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
      const categoriasDisponiveis = Object.keys(categorias);
      const categoriaInicial = categoriasDisponiveis[Math.floor(Math.random() * categoriasDisponiveis.length)];
      salas[salaId] = {
        usuarios: {},
        categoria: categoriaInicial,
        respostas: sortearPalavras(categoriaInicial),
        acertadas: [],
        jaUsadas: [categoriaInicial],
        timer: null,
        metadeTempoAviso: null,
        dezSegundosAviso: null,
        fimDaRodada: null,
        rodada: 1,
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
    sala.usuarios[socket.id] = { nome, pontos: 0, ultimoAtivo: Date.now() };
    socket.join(salaId);
    socket.emit("dadosSala", {
      categoria: sala.categoria,
      acertadas: sala.acertadas,
      rodada: sala.rodada,
    });
    const tempoRestante = Math.max(0, Math.floor((sala.fimDaRodada - Date.now()) / 1000));
    socket.emit("mensagem", {
      nome: "Sistema",
      texto: `Rodada em andamento! Categoria: ${sala.categoria}`,
      acertou: false,
    });
    socket.emit("mensagem", {
      nome: "Sistema",
      texto: `Você tem ${tempoRestante} segundos restantes nesta rodada.`,
      acertou: false,
    });
    io.to(salaId).emit("usuariosAtualizados", sala.usuarios);
  });

  socket.on("chutar", ({ salaId, chute }) => {
    const sala = salas[salaId];
    if (!sala || !sala.usuarios[socket.id]) return;
    sala.usuarios[socket.id].ultimoAtivo = Date.now();

    const resultado = avaliarChute(chute, sala.respostas, sala.acertadas);

    if (resultado.acertou) {
      const palavraLower = resultado.respostaCorreta.toLowerCase();
      const usuario = sala.usuarios[socket.id];

      // Se a palavra ainda não foi acertada na sala, pontua e adiciona
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
          if (sala.rodada > MAX_RODADAS) {
            enviarPlacarFinal(salaId);
            io.to(salaId).emit("mensagem", {
              nome: "Sistema",
              texto: "Rodada finalizada! Iniciando nova partida em 10 segundos...",
              tipo: "info",
              acertou: false,
            });
            setTimeout(() => {
              reiniciarPartida(salaId);
            }, DELAY_REINICIO);
          } else {
            setTimeout(() => {
              io.to(salaId).emit("mensagem", {
                nome: "Sistema",
                texto: "Todas as respostas foram acertadas! Preparando nova rodada...",
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

      // Envia o chute para todos, sempre, mesmo se não pontuou
      io.to(salaId).emit("mensagem", {
        nome: usuario.nome,
        texto: chute,
        acertou: true,
      });
    } else if (resultado.perto) {
      // chute "está perto" - só para o jogador
      socket.emit("mensagem", {
        nome: "Sistema",
        texto: `${chute} está perto!`,
        acertou: false,
      });
    } else {
      // chute errado para a sala toda
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
