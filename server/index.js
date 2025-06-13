require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const categorias = require("./data/categorias.json");

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const allowedOrigins = [process.env.FRONTEND_URL];

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

let salas = {};

function sortearPalavras(categoria) {
  const palavras = [...categorias[categoria]];
  const sorteadas = [];
  while (sorteadas.length < 5 && palavras.length > 0) {
    const index = Math.floor(Math.random() * palavras.length);
    sorteadas.push(palavras.splice(index, 1)[0]);
  }
  return sorteadas;
}

function iniciarRodada(salaId) {
  const sala = salas[salaId];
  if (!sala) return;

  const TEMPO_RODADA = 90000;
  sala.fimDaRodada = Date.now() + TEMPO_RODADA;

  // Limpa timers antigos
  if (sala.timer) clearTimeout(sala.timer);
  if (sala.metadeTempoAviso) clearTimeout(sala.metadeTempoAviso);
  if (sala.dezSegundosAviso) clearTimeout(sala.dezSegundosAviso);

  io.to(salaId).emit("mensagem", {
    nome: "Sistema",
    texto: `Rodada iniciada! Você tem ${TEMPO_RODADA / 1000} segundos para acertar as palavras.`,
    acertou: false,
  });

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
    const categoriasDisponiveis = Object.keys(categorias).filter((cat) => !sala.jaUsadas.includes(cat));

    if (categoriasDisponiveis.length === 0) {
      sala.jaUsadas = [];
    }

    const novaCategoria = categoriasDisponiveis[Math.floor(Math.random() * categoriasDisponiveis.length)];

    sala.categoria = novaCategoria;
    sala.respostas = sortearPalavras(novaCategoria);
    sala.acertadas = [];
    sala.jaUsadas.push(novaCategoria);

    io.to(salaId).emit("dadosSala", {
      categoria: sala.categoria,
      acertadas: sala.acertadas,
    });

    io.to(salaId).emit("mensagem", {
      nome: "Sistema",
      texto: `Tempo esgotado! Nova categoria: ${sala.categoria}`,
      acertou: false,
    });

    iniciarRodada(salaId);
  }, TEMPO_RODADA);
}

io.on("connection", (socket) => {
  socket.on("entrarSala", ({ salaId, nome }) => {
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
      };

      iniciarRodada(salaId);
    }

    salas[salaId].usuarios[socket.id] = { nome, pontos: 0 };
    socket.join(salaId);

    socket.emit("dadosSala", {
      categoria: salas[salaId].categoria,
      acertadas: salas[salaId].acertadas,
    });

    // Mensagem de tempo restante ao entrar
    const tempoRestante = Math.max(0, Math.floor((salas[salaId].fimDaRodada - Date.now()) / 1000));

    socket.emit("mensagem", {
      nome: "Sistema",
      texto: `Rodada em andamento! Categoria: ${salas[salaId].categoria}`,
      acertou: false,
    });

    socket.emit("mensagem", {
      nome: "Sistema",
      texto: `Você tem ${tempoRestante} segundos restantes nesta rodada.`,
      acertou: false,
    });

    io.to(salaId).emit("usuariosAtualizados", salas[salaId].usuarios);
  });

  socket.on("chutar", ({ salaId, chute }) => {
    const sala = salas[salaId];
    if (!sala) return;

    const chuteNormalizado = chute.trim().toLowerCase();
    const acertou = sala.respostas.includes(chuteNormalizado) && !sala.acertadas.includes(chuteNormalizado);

    if (acertou) {
      sala.acertadas.push(chuteNormalizado);
      sala.usuarios[socket.id].pontos++;

      io.to(salaId).emit("acerto", {
        nome: sala.usuarios[socket.id].nome,
        palavra: chuteNormalizado,
        acertadas: sala.acertadas,
      });

      io.to(salaId).emit("usuariosAtualizados", sala.usuarios);

      if (sala.acertadas.length === sala.respostas.length) {
        const categoriasDisponiveis = Object.keys(categorias).filter((cat) => !sala.jaUsadas.includes(cat));

        if (categoriasDisponiveis.length === 0) {
          sala.jaUsadas = [];
        }

        const novaCategoria = categoriasDisponiveis[Math.floor(Math.random() * categoriasDisponiveis.length)];

        sala.categoria = novaCategoria;
        sala.respostas = sortearPalavras(novaCategoria);
        sala.acertadas = [];
        sala.jaUsadas.push(novaCategoria);

        io.to(salaId).emit("dadosSala", {
          categoria: sala.categoria,
          acertadas: sala.acertadas,
        });

        io.to(salaId).emit("mensagem", {
          nome: "Sistema",
          texto: `Todas as palavras foram acertadas! Nova categoria: ${sala.categoria}`,
          acertou: false,
        });

        iniciarRodada(salaId);
      }
    }

    io.to(salaId).emit("mensagem", {
      nome: sala.usuarios[socket.id].nome,
      texto: chute,
      acertou,
    });
  });

  socket.on("disconnect", () => {
    for (const salaId in salas) {
      if (salas[salaId].usuarios[socket.id]) {
        delete salas[salaId].usuarios[socket.id];
        io.to(salaId).emit("usuariosAtualizados", salas[salaId].usuarios);
        if (Object.keys(salas[salaId].usuarios).length === 0) delete salas[salaId];
      }
    }
  });
});

app.get("/categorias", (req, res) => {
  res.json(Object.keys(categorias));
});

server.listen(PORT, () => {
  console.log("Servidor rodando na porta 3000");
});
