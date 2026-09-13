require("dotenv").config();

const app =
    require("./src/app");

const PORT =
    Number(
        process.env.PORT
        || 3000
    );


app.listen(
    PORT,
    () => {

        console.log(
            `NovaBank running at http://localhost:${PORT}`
        );

        console.log(
            `Health endpoint: http://localhost:${PORT}/api/health`
        );
    }
);
