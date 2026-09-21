import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Supabase clients
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(
    rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 300,
    })
);

// ---------- Serve frontend ----------
app.use(express.static("public"));

app.get("/", (req, res) => {
    res.sendFile("index.html", { root: "public" });
});

// ---------- Auth helper ----------
async function getUser(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
        return null;
    }
    const token = authHeader.split(" ")[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    return user;
}

// Middleware that requires login
async function requireAuth(req, res, next) {
    const user = await getUser(req);
    if (!user) {
        return res.status(401).json({ error: "Unauthorized – please log in" });
    }
    req.user = user;
    // Create a client that runs as this user (RLS applies automatically)
    req.sb = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY,
        {
            global: {
                headers: { Authorization: `Bearer ${req.headers.authorization.split(" ")[1]}` },
            },
        }
    );
    next();
}

// ---------- Routes ----------

// Get / create month data
app.get("/api/month/:month", requireAuth, async (req, res) => {
    const { month } = req.params;
    const { data: monthRow } = await req.sb
        .from("months")
        .select("salary")
        .eq("month", month)
        .maybeSingle();

    const { data: items, error } = await req.sb
        .from("items")
        .select("*")
        .eq("month", month)
        .order("created_at");

    if (error) return res.status(500).json({ error: error.message });

    res.json({
        salary: monthRow?.salary ?? 0,
        items: items || [],
    });
});

// Save salary for a month
app.put("/api/month/:month", requireAuth, async (req, res) => {
    const { month } = req.params;
    const salary = Number(req.body.salary) || 0;

    const { error } = await req.sb.from("months").upsert(
        {
            user_id: req.user.id,
            month,
            salary,
        },
        { onConflict: "user_id,month" }
    );

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
});

// Add item
app.post("/api/month/:month/items", requireAuth, async (req, res) => {
    const { month } = req.params;
    const { name, category, amount, recurring } = req.body;

    const { data, error } = await req.sb
        .from("items")
        .insert({
            user_id: req.user.id,
            month,
            name: String(name).trim().slice(0, 80),
            category: category || "Other",
            amount: Number(amount) || 0,
            recurring: !!recurring,
            paid: false,
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// Update item
app.patch("/api/items/:id", requireAuth, async (req, res) => {
    const { id } = req.params;
    const allowed = ["name", "category", "amount", "paid", "recurring"];
    const patch = {};
    for (const k of allowed) {
        if (k in req.body) patch[k] = req.body[k];
    }

    const { data, error } = await req.sb
        .from("items")
        .update(patch)
        .eq("id", id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// Delete item
app.delete("/api/items/:id", requireAuth, async (req, res) => {
    const { id } = req.params;

    const { data, error } = await req.sb
        .from("items")
        .delete()
        .eq("id", id)
        .select();

    if (error) return res.status(500).json({ error: error.message });

    // RLS (or a wrong id) can make Supabase delete 0 rows without an error
    if (!data || data.length === 0) {
        return res
            .status(404)
            .json({ error: "Account not found, or you're not allowed to delete it." });
    }

    res.json({ ok: true });
});

// History (last 12 months)
app.get("/api/history", requireAuth, async (req, res) => {
    const { data: months } = await req.sb
        .from("months")
        .select("month, salary")
        .order("month", { ascending: false })
        .limit(24);

    const { data: items } = await req.sb
        .from("items")
        .select("month, amount")
        .in(
            "month",
            (months || []).map((m) => m.month)
        );

    const spentByMonth = {};
    (items || []).forEach((i) => {
        spentByMonth[i.month] = (spentByMonth[i.month] || 0) + Number(i.amount);
    });

    const history = (months || [])
        .map((m) => {
            const spent = spentByMonth[m.month] || 0;
            return {
                month: m.month,
                salary: Number(m.salary),
                spent,
                left: Number(m.salary) - spent,
            };
        })
        .reverse();

    res.json(history);
});

// Copy monthly accounts from previous month
app.post("/api/month/:month/copy", requireAuth, async (req, res) => {
    const { month } = req.params;
    const [y, m] = month.split("-").map(Number);
    const prev = new Date(y, m - 2, 1);
    const source = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;

    const { data: existing } = await req.sb
        .from("items")
        .select("name")
        .eq("month", month);

    const existingNames = new Set((existing || []).map((i) => i.name.toLowerCase()));

    const { data: toCopy } = await req.sb
        .from("items")
        .select("name, category, amount, recurring")
        .eq("month", source)
        .eq("recurring", true);

    const newItems = (toCopy || [])
        .filter((i) => !existingNames.has(i.name.toLowerCase()))
        .map((i) => ({
            user_id: req.user.id,
            month,
            name: i.name,
            category: i.category,
            amount: i.amount,
            recurring: true,
            paid: false,
        }));

    if (newItems.length) {
        await req.sb.from("items").insert(newItems);
    }

    res.json({ copied: newItems.length, source });
});

// CSV export
app.get("/api/export.csv", requireAuth, async (req, res) => {
    const { data: items } = await req.sb
        .from("items")
        .select("month, name, category, amount, paid, recurring")
        .order("month")
        .order("name");

    const header = "month,name,category,amount,paid,recurring\n";
    const rows = (items || [])
        .map(
            (i) =>
                `${i.month},"${i.name.replace(/"/g, '""')}",${i.category},${i.amount},${i.paid},${i.recurring}`
        )
        .join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=salary-export.csv");
    res.send(header + rows);
});

// Health check
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
    console.log(`Salary tracker API running on http://localhost:${PORT}`);
});
